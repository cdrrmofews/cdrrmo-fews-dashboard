from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from database import init_db, get_db
from auth import hash_password, authenticate_user, create_token

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Lock this down to your Vercel URL after deploying
    allow_methods=["*"],
    allow_headers=["*"],
)

init_db()

# ─── A shared secret so only your Arduino can POST data ───────────────────────
# Change this to any random string. Must match what's in your Arduino sketch.
ARDUINO_SECRET = "fews-secret-2025"

# ─── Auth models ─────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str

class RegisterRequest(BaseModel):
    username: str
    password: str
    role: str = "operator"

# ─── Sensor data model ───────────────────────────────────────────────────────

class SensorReading(BaseModel):
    station_id: str          # e.g. "fews_1"
    water_level_cm: int      # e.g. 320
    status: str              # NORMAL / ADVISORY / WARNING / CRITICAL
    battery_pct: int = 100   # fixed 100 for now
    latitude: float = 13.7703472
    longitude: float = 121.0525449

# ─── Auth endpoints ───────────────────────────────────────────────────────────

@app.post("/login")
def login(req: LoginRequest):
    user = authenticate_user(req.username, req.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return {"token": create_token(req.username), "username": req.username}

@app.post("/register")
def register(req: RegisterRequest):
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
            (req.username, hash_password(req.password), req.role)
        )
        conn.commit()
    except Exception:
        raise HTTPException(status_code=400, detail="Username already exists")
    finally:
        conn.close()
    return {"message": "User created"}

# ─── Sensor data endpoints ────────────────────────────────────────────────────

@app.post("/data")
def receive_data(reading: SensorReading, x_arduino_secret: Optional[str] = Header(None)):
    """
    Arduino POSTs to this endpoint every ~10 seconds.
    Requires X-Arduino-Secret header to match ARDUINO_SECRET.
    """
    if x_arduino_secret != ARDUINO_SECRET:
        raise HTTPException(status_code=403, detail="Unauthorized")

    conn = get_db()
    conn.execute(
        """INSERT INTO sensor_readings
           (station_id, water_level_cm, status, battery_pct, latitude, longitude)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (
            reading.station_id,
            reading.water_level_cm,
            reading.status,
            reading.battery_pct,
            reading.latitude,
            reading.longitude,
        )
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/data/latest")
def get_latest():
    """
    Dashboard polls this every 5 seconds.
    Returns the most recent reading for each station_id.
    """
    conn = get_db()
    rows = conn.execute("""
        SELECT station_id, water_level_cm, status, battery_pct,
               latitude, longitude, timestamp
        FROM sensor_readings
        WHERE id IN (
            SELECT MAX(id) FROM sensor_readings GROUP BY station_id
        )
        ORDER BY station_id
    """).fetchall()
    conn.close()

    return {
        row["station_id"]: {
            "water_level_cm": row["water_level_cm"],
            "status":         row["status"],
            "battery_pct":    row["battery_pct"],
            "latitude":       row["latitude"],
            "longitude":      row["longitude"],
            "timestamp":      row["timestamp"],
        }
        for row in rows
    }


@app.get("/data/history/{station_id}")
def get_history(station_id: str, limit: int = 50):
    """
    Returns the last N readings for a station (for charts).
    """
    conn = get_db()
    rows = conn.execute("""
        SELECT water_level_cm, status, battery_pct, timestamp
        FROM sensor_readings
        WHERE station_id = ?
        ORDER BY id DESC
        LIMIT ?
    """, (station_id, limit)).fetchall()
    conn.close()

    return [dict(row) for row in reversed(rows)]