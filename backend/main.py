from fastapi import FastAPI, HTTPException, Depends, Header
from mqtt_bridge import start_bridge_thread
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional

from database import get_db, release_db, init_db
from auth import hash_password, verify_password, create_token, decode_token

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

VALID_ROLES = {"Admin", "Operator"}

@app.on_event("startup")
def startup():
    try:
        init_db()
        conn = get_db()
        cur  = conn.cursor()
        try:
            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20)")
            cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_enabled BOOLEAN NOT NULL DEFAULT FALSE")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS fews_units (
                    id               SERIAL PRIMARY KEY,
                    device_id        VARCHAR(50) UNIQUE NOT NULL,
                    name             VARCHAR(100) NOT NULL,
                    location         VARCHAR(100),
                    installed_date   VARCHAR(50),
                    technician       VARCHAR(100),
                    description      TEXT,
                    threshold_warning INT NOT NULL DEFAULT 200,
                    threshold_danger  INT NOT NULL DEFAULT 300,
                    updated_at        TIMESTAMPTZ DEFAULT NOW()
                )
            """)
            cur.execute("SELECT id FROM fews_units WHERE device_id = 'fews_1'")
            if not cur.fetchone():
                cur.execute("""
                    INSERT INTO fews_units (device_id, name, location, installed_date, technician, description, threshold_warning, threshold_danger)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    "fews_1", "FEWS 1", "Bolbok", "-", "Engr. Andrew Van Ryan",
                    "Deployed along the upper tributary of Sta. Rita River. Monitors early upstream surge from heavy rainfall in the Mataas na Gulod watershed.",
                    200, 300
                ))
            conn.commit()
        except Exception as e:
            print(f"[STARTUP] Migration error: {e}")
            conn.rollback()
        finally:
            cur.close()
            release_db(conn)
    except Exception as e:
        print(f"[STARTUP] DB connection failed, continuing anyway: {e}")
    start_bridge_thread()

# --- AUTH HELPERS ---

def get_current_user(authorization: str = Header(...)):
    try:
        scheme, token = authorization.split()
        if scheme.lower() != "bearer":
            raise HTTPException(status_code=401, detail="Invalid auth scheme")
        payload = decode_token(token)
        return payload
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

def require_admin(user=Depends(get_current_user)):
    if user.get("role") != "Admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user

# --- SCHEMAS ---

class LoginRequest(BaseModel):
    username: str
    password: str

class SensorData(BaseModel):
    device_id:      str
    water_level_cm: float
    battery_pct:    float
    status:         str
    latitude:       Optional[float] = None
    longitude:      Optional[float] = None
    is_immediate:   Optional[bool]  = False

class CreateUserRequest(BaseModel):
    name:       str
    email:      str
    password:   str
    role:       str = "Operator"
    department: str = "Operations"
    phone:      Optional[str] = None

class UpdateUserRequest(BaseModel):
    role:       Optional[str] = None
    department: Optional[str] = None

class UpdateProfileRequest(BaseModel):
    name:  Optional[str] = None
    photo: Optional[str] = None

class ChangeEmailRequest(BaseModel):
    email: str

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password:     str

class ChangePhoneRequest(BaseModel):
    phone: str

class SmsEnabledRequest(BaseModel):
    sms_enabled: bool

class CreateLogRequest(BaseModel):
    station:   str = "System"
    type:      str = "system"
    message:   str
    user_name: Optional[str] = None

# ── NEW: Siren control schema ─────────────────────────────────────────────────
class SirenRequest(BaseModel):
    state: str  # "on" or "off"
# ─────────────────────────────────────────────────────────────────────────────

# --- AUTH ---

@app.post("/login")
def login(req: LoginRequest):
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute(
            "SELECT * FROM users WHERE email = %s OR name = %s",
            (req.username, req.username)
        )
        user = cur.fetchone()
        if not user or not verify_password(req.password, user["password"]):
            raise HTTPException(status_code=401, detail="Invalid credentials")
        token = create_token(user["id"], user["role"])

        cur.execute("""
            INSERT INTO system_logs (station, type, message, user_name)
            VALUES (%s, %s, %s, %s)
        """, (
            "System", "system",
            f"{user['name']} ({user['role']}, {user['department']}) has logged in to the system",
            user["name"]
        ))
        conn.commit()

        return {
            "token":      token,
            "username":   user["name"],
            "role":       user["role"],
            "department": user["department"],
            "email":      user["email"],
            "id":         user["id"],
            "photo":      user.get("photo"),
        }
    finally:
        cur.close()
        release_db(conn)

# --- PROFILE ---

@app.put("/users/me")
def update_profile(req: UpdateProfileRequest, user=Depends(get_current_user)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        user_id = int(user["sub"])
        fields = []
        values = []
        if req.name  is not None: fields.append("name = %s");  values.append(req.name)
        if req.photo is not None: fields.append("photo = %s"); values.append(req.photo)
        if not fields:
            raise HTTPException(status_code=400, detail="Nothing to update")
        values.append(user_id)
        cur.execute(
            f"UPDATE users SET {', '.join(fields)} WHERE id = %s RETURNING id, name, email, role, department, photo",
            values
        )
        conn.commit()
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        return row
    finally:
        cur.close()
        release_db(conn)

@app.put("/users/me/email")
def change_email(req: ChangeEmailRequest, user=Depends(get_current_user)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        user_id = int(user["sub"])
        cur.execute("SELECT id FROM users WHERE email = %s AND id != %s", (req.email, user_id))
        if cur.fetchone():
            raise HTTPException(status_code=400, detail="Email already in use by another account.")
        cur.execute(
            "UPDATE users SET email = %s WHERE id = %s RETURNING id, name, email, role, department, photo",
            (req.email, user_id)
        )
        conn.commit()
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        return row
    finally:
        cur.close()
        release_db(conn)

@app.put("/users/me/password")
def change_password(req: ChangePasswordRequest, user=Depends(get_current_user)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        user_id = int(user["sub"])
        cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        if not verify_password(req.current_password, row["password"]):
            raise HTTPException(status_code=400, detail="Current password is incorrect.")
        if len(req.new_password) < 6:
            raise HTTPException(status_code=400, detail="New password must be at least 6 characters.")
        cur.execute(
            "UPDATE users SET password = %s WHERE id = %s RETURNING id",
            (hash_password(req.new_password), user_id)
        )
        conn.commit()
        return {"ok": True}
    finally:
        cur.close()
        release_db(conn)

@app.put("/users/me/phone")
def change_phone(req: ChangePhoneRequest, user=Depends(get_current_user)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        user_id = int(user["sub"])
        cur.execute(
            "UPDATE users SET phone = %s WHERE id = %s RETURNING id, name, email, role, department, photo, phone",
            (req.phone, user_id)
        )
        conn.commit()
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        return row
    finally:
        cur.close()
        release_db(conn)

@app.put("/users/{user_id}/sms")
def update_sms_enabled(user_id: int, req: SmsEnabledRequest, user=Depends(get_current_user)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute(
            "UPDATE users SET sms_enabled = %s WHERE id = %s RETURNING id",
            (req.sms_enabled, user_id)
        )
        conn.commit()
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="User not found")
        return {"ok": True}
    finally:
        cur.close()
        release_db(conn)

# --- SENSOR DATA ---

@app.post("/data/ingest")
def ingest(data: SensorData):
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute("""
            INSERT INTO sensor_readings
                (device_id, water_level_cm, battery_pct, status, latitude, longitude, is_immediate)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (data.device_id, data.water_level_cm, data.battery_pct,
              data.status, data.latitude, data.longitude, data.is_immediate))
        conn.commit()
        return {"ok": True}
    finally:
        cur.close()
        release_db(conn)

@app.get("/data/latest")
def latest():
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute("""
            SELECT DISTINCT ON (device_id) *
            FROM sensor_readings
            ORDER BY device_id, timestamp DESC
        """)
        rows = cur.fetchall()
        result = {}
        for row in rows:
            key = row["device_id"].lower().replace("-", "_").replace(" ", "_")
            result[key] = dict(row)
        return result
    finally:
        cur.close()
        release_db(conn)

@app.get("/data/history")
def history():
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute("""
            SELECT device_id, water_level_cm, timestamp
            FROM (
                SELECT device_id, water_level_cm, timestamp
                FROM sensor_readings
                WHERE device_id = 'fews_1'
                ORDER BY timestamp DESC
                LIMIT 12
            ) sub
            ORDER BY timestamp ASC
        """)
        rows = cur.fetchall()
        return [dict(r) for r in rows]
    finally:
        cur.close()
        release_db(conn)

# --- SYSTEM LOGS ---

@app.post("/logs")
def create_log(req: CreateLogRequest, user=Depends(get_current_user)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute("""
            INSERT INTO system_logs (station, type, message, user_name)
            VALUES (%s, %s, %s, %s)
            RETURNING id, station, type, message, user_name, timestamp
        """, (req.station, req.type, req.message, req.user_name))
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        release_db(conn)

@app.get("/logs")
def get_logs(user=Depends(get_current_user)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute("""
            SELECT id, station, type, message, user_name, timestamp
            FROM system_logs
            ORDER BY timestamp DESC
            LIMIT 500
        """)
        return cur.fetchall()
    finally:
        cur.close()
        release_db(conn)

# --- USER MANAGEMENT (Admin only) ---

@app.get("/users")
def list_users(user=Depends(get_current_user)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute("SELECT id, name, email, role, department, photo, phone, sms_enabled, created_at FROM users ORDER BY id")
        return cur.fetchall()
    finally:
        cur.close()
        release_db(conn)

@app.post("/users")
def create_user(req: CreateUserRequest, admin=Depends(require_admin)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        if req.role not in VALID_ROLES:
            raise HTTPException(status_code=400, detail=f"Invalid role. Must be one of: {', '.join(VALID_ROLES)}")
        cur.execute("SELECT id FROM users WHERE email = %s", (req.email,))
        if cur.fetchone():
            raise HTTPException(status_code=400, detail="Email already exists")
        cur.execute("""
            INSERT INTO users (name, email, password, role, department, phone)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id, name, email, role, department, phone
        """, (req.name, req.email, hash_password(req.password), req.role, req.department, req.phone))
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        release_db(conn)

@app.put("/users/{user_id}")
def update_user(user_id: int, req: UpdateUserRequest, admin=Depends(require_admin)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        fields = []
        values = []
        if req.role is not None:
            if req.role not in VALID_ROLES:
                raise HTTPException(status_code=400, detail=f"Invalid role. Must be one of: {', '.join(VALID_ROLES)}")
            fields.append("role = %s")
            values.append(req.role)
        if req.department is not None:
            fields.append("department = %s")
            values.append(req.department)
        if not fields:
            raise HTTPException(status_code=400, detail="Nothing to update")
        values.append(user_id)
        cur.execute(
            f"UPDATE users SET {', '.join(fields)} WHERE id = %s RETURNING id, name, email, role, department",
            values
        )
        conn.commit()
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        return row
    finally:
        cur.close()
        release_db(conn)

@app.delete("/users/{user_id}")
def delete_user(user_id: int, admin=Depends(require_admin)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute("DELETE FROM users WHERE id = %s RETURNING id", (user_id,))
        conn.commit()
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="User not found")
        return {"ok": True}
    finally:
        cur.close()
        release_db(conn)

@app.get("/")
def root():
    return {"status": "CDRRMO FEWS API online"}

# --- FEWS UNITS ---

class UpdateUnitRequest(BaseModel):
    installed_date:    Optional[str] = None
    technician:        Optional[str] = None
    description:       Optional[str] = None
    threshold_warning: Optional[int] = None
    threshold_danger:  Optional[int] = None

@app.get("/units")
def get_units(user=Depends(get_current_user)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute("SELECT * FROM fews_units ORDER BY id")
        return cur.fetchall()
    finally:
        cur.close()
        release_db(conn)

@app.put("/units/{device_id}")
def update_unit(device_id: str, req: UpdateUnitRequest, user=Depends(get_current_user)):
    if user["role"] not in ("Admin", "Operator"):
        raise HTTPException(status_code=403, detail="Not authorized")
    conn = get_db()
    cur  = conn.cursor()
    try:
        fields, values = [], []
        if req.installed_date    is not None: fields.append("installed_date = %s");    values.append(req.installed_date)
        if req.technician        is not None: fields.append("technician = %s");        values.append(req.technician)
        if req.description       is not None: fields.append("description = %s");       values.append(req.description)
        if req.threshold_warning is not None: fields.append("threshold_warning = %s"); values.append(req.threshold_warning)
        if req.threshold_danger  is not None: fields.append("threshold_danger = %s");  values.append(req.threshold_danger)
        if not fields:
            raise HTTPException(status_code=400, detail="No fields to update")
        fields.append("updated_at = NOW()")
        values.append(device_id)
        cur.execute(f"UPDATE fews_units SET {', '.join(fields)} WHERE device_id = %s RETURNING *", values)
        conn.commit()
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Unit not found")
        return row
    finally:
        cur.close()
        release_db(conn)

# ── NEW: Siren control endpoint ───────────────────────────────────────────────
@app.post("/siren/{device_id}")
def control_siren(device_id: str, req: SirenRequest, user=Depends(get_current_user)):
    from mqtt_bridge import publish_siren
    publish_siren(device_id, req.state)
    return {"ok": True}
# ─────────────────────────────────────────────────────────────────────────────