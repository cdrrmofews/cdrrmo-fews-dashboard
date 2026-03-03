from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import traceback

from database import get_db, init_db
from auth import hash_password, verify_password, create_token, decode_token

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def startup():
    init_db()

# ─── AUTH HELPERS ─────────────────────────────────────────────────────────────

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

# ─── SCHEMAS ──────────────────────────────────────────────────────────────────

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

class CreateUserRequest(BaseModel):
    name:       str
    email:      str
    password:   str
    role:       str = "Viewer"
    department: str = "Operations"

class UpdateUserRequest(BaseModel):
    role:       Optional[str] = None
    department: Optional[str] = None

# ─── AUTH ─────────────────────────────────────────────────────────────────────

@app.post("/login")
def login(req: LoginRequest):
    conn = get_db()
    cur  = conn.cursor()
    try:
        # Accept login by email OR username (name)
        cur.execute(
            "SELECT * FROM users WHERE email = %s OR name = %s",
            (req.username, req.username)
        )
        user = cur.fetchone()
        if not user or not verify_password(req.password, user["password"]):
            raise HTTPException(status_code=401, detail="Invalid credentials")
        token = create_token(user["id"], user["role"])
        return {
            "token":      token,
            "username":   user["name"],
            "role":       user["role"],
            "department": user["department"],
            "email":      user["email"],
            "id":         user["id"],
        }
    finally:
        cur.close()
        conn.close()

# ─── SENSOR DATA ──────────────────────────────────────────────────────────────

@app.post("/data/ingest")
def ingest(data: SensorData):
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute("""
            INSERT INTO sensor_readings
                (device_id, water_level_cm, battery_pct, status, latitude, longitude)
            VALUES (%s, %s, %s, %s, %s, %s)
        """, (data.device_id, data.water_level_cm, data.battery_pct,
              data.status, data.latitude, data.longitude))
        conn.commit()
        return {"ok": True}
    finally:
        cur.close()
        conn.close()

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
        conn.close()

# ─── USER MANAGEMENT (Admin only) ────────────────────────────────────────────

@app.get("/users")
def list_users(admin=Depends(require_admin)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute("SELECT id, name, email, role, department, created_at FROM users ORDER BY id")
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()

@app.post("/users")
def create_user(req: CreateUserRequest, admin=Depends(require_admin)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute("SELECT id FROM users WHERE email = %s", (req.email,))
        if cur.fetchone():
            raise HTTPException(status_code=400, detail="Email already exists")
        cur.execute("""
            INSERT INTO users (name, email, password, role, department)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id, name, email, role, department
        """, (req.name, req.email, hash_password(req.password), req.role, req.department))
        conn.commit()
        return cur.fetchone()
    finally:
        cur.close()
        conn.close()

@app.put("/users/{user_id}")
def update_user(user_id: int, req: UpdateUserRequest, admin=Depends(require_admin)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        fields = []
        values = []
        if req.role       is not None: fields.append("role = %s");       values.append(req.role)
        if req.department is not None: fields.append("department = %s"); values.append(req.department)
        if not fields:
            raise HTTPException(status_code=400, detail="Nothing to update")
        values.append(user_id)
        cur.execute(f"UPDATE users SET {', '.join(fields)} WHERE id = %s RETURNING id, name, email, role, department", values)
        conn.commit()
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        return row
    finally:
        cur.close()
        conn.close()

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
        conn.close()

@app.get("/")
def root():
    return {"status": "CDRRMO FEWS API online"}