from fastapi import FastAPI, HTTPException, Depends, Header
from mqtt_bridge import start_bridge_thread
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional

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

VALID_ROLES = {"Admin", "Operator"}

@app.on_event("startup")
def startup():
    init_db()
    # Migrate: add phone and sms_enabled columns if they don't exist yet
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20)")
        cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_enabled BOOLEAN NOT NULL DEFAULT FALSE")
        conn.commit()
    except Exception:
        conn.rollback()
    finally:
        cur.close()
        conn.close()
    start_bridge_thread()

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
    role:       str = "Operator"
    department: str = "Operations"

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

# ─── AUTH ─────────────────────────────────────────────────────────────────────

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
        conn.close()

# ─── PROFILE ──────────────────────────────────────────────────────────────────

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
        conn.close()

@app.put("/users/me/email")
def change_email(req: ChangeEmailRequest, user=Depends(get_current_user)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        user_id = int(user["sub"])
        # Check email not already taken by another user
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
        conn.close()

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
        conn.close()

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
        conn.close()

@app.put("/users/{user_id}/sms")
def update_sms_enabled(user_id: int, req: SmsEnabledRequest, user=Depends(get_current_user)):
    # Admin can toggle anyone, operators can only toggle themselves
    if user.get("role") != "Admin" and int(user["sub"]) != user_id:
        raise HTTPException(status_code=403, detail="Not authorized")
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

@app.get("/data/history")
def history():
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute("""
            SELECT device_id, water_level_cm, timestamp
            FROM sensor_readings
            WHERE device_id = 'fews_1'
              AND timestamp >= NOW() - INTERVAL '12 hours'
            ORDER BY timestamp ASC
        """)
        rows = cur.fetchall()
        return [dict(r) for r in rows]
    finally:
        cur.close()
        conn.close()

# ─── SYSTEM LOGS ──────────────────────────────────────────────────────────────

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
        conn.close()

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
        conn.close()

# ─── USER MANAGEMENT (Admin only) ─────────────────────────────────────────────

@app.get("/users")
def list_users(admin=Depends(require_admin)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute("SELECT id, name, email, role, department, photo, phone, sms_enabled, created_at FROM users ORDER BY id")
        return cur.fetchall()
    finally:
        cur.close()
        conn.close()

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