from fastapi import FastAPI, HTTPException, Depends, Header
from mqtt_bridge import start_bridge_thread
from fastapi.middleware.cors import CORSMiddleware

from database import get_db, release_db, init_db
from auth import hash_password, verify_password, create_token, decode_token

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

import os, uuid, base64, re, time
from supabase import create_client

from models import (
    LoginRequest, CreateUserRequest, UpdateUserRequest,
    UpdateProfileRequest, ChangeEmailRequest, ChangePasswordRequest,
    ChangePhoneRequest, SmsEnabledRequest, CreateLogRequest,
    SirenRequest, UpdateUnitRequest,
)

SUPABASE_URL         = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
supabase             = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY) if SUPABASE_URL and SUPABASE_SERVICE_KEY else None

# --- APP SETUP ---

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://cdrrmo-fews.vercel.app",
        "https://cdrrmo-fews.onrender.com",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin"
        return response

app.add_middleware(SecurityHeadersMiddleware)

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

VALID_ROLES = {"Admin", "Operator"}

@app.on_event("startup")
def startup():
    try:
        init_db()
        conn = get_db()
        cur  = conn.cursor()
        try:
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
        user_id = int(payload["sub"])
        token_version = payload.get("token_version", 0)
        conn = get_db()
        cur  = conn.cursor()
        try:
            cur.execute("SELECT token_version FROM users WHERE id = %s", (user_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=401, detail="User no longer exists")
            if row["token_version"] != token_version:
                raise HTTPException(status_code=401, detail="Session expired")
        finally:
            cur.close()
            release_db(conn)
        return payload
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

def require_admin(user=Depends(get_current_user)):
    if user.get("role") != "Admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user

# --- AUTH ---

@app.post("/login")
@limiter.limit("10/minute")
def login(request: Request, req: LoginRequest):
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
        token = create_token(user["id"], user["role"], user["token_version"])

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

@app.post("/logout")
def logout(user=Depends(get_current_user)):
    conn = get_db()
    cur  = conn.cursor()
    try:
        user_id = int(user["sub"])
        cur.execute(
            "UPDATE users SET token_version = token_version + 1 WHERE id = %s",
            (user_id,)
        )
        conn.commit()
        return {"ok": True}
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
        if req.name is not None:
            fields.append("name = %s")
            values.append(req.name)

        if req.photo is not None:
            # If it's a base64 image, upload to Supabase Storage
            if req.photo.startswith("data:image/"):
                if supabase is None:
                    raise HTTPException(status_code=500, detail="Storage not configured.")
                try:
                    header, data = req.photo.split(",", 1)
                    decoded = base64.b64decode(data)
                    if len(decoded) > 5 * 1024 * 1024:
                        raise HTTPException(status_code=400, detail="Photo must be under 5MB.")
                    mime_match = re.search(r"data:(image/\w+);base64", header)
                    mime_type  = mime_match.group(1) if mime_match else "image/jpeg"
                    ext        = mime_type.split("/")[1]
                    filename   = f"user_{user_id}_{uuid.uuid4().hex[:8]}.{ext}"
                    supabase.storage.from_("avatars").upload(
                        filename,
                        decoded,
                        {"content-type": mime_type, "upsert": "true"}
                    )
                    photo_url = f"{SUPABASE_URL}/storage/v1/object/public/avatars/{filename}"
                except HTTPException:
                    raise
                except Exception as e:
                    raise HTTPException(status_code=500, detail=f"Photo upload failed: {e}")
                fields.append("photo = %s")
                values.append(photo_url)
            else:
                # Already a URL, save as-is
                fields.append("photo = %s")
                values.append(req.photo)

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
            "UPDATE users SET password = %s, token_version = token_version + 1 WHERE id = %s RETURNING id",
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

@app.get("/status/fews1")
def fews1_status():
    from mqtt_bridge import get_last_online
    last = get_last_online("fews_1")
    if last == 0:
        return { "online": False, "last_seen": None }
    age = time.time() - last
    return {
        "online":    age < 600,
        "last_seen": last,
    }

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
def get_logs(
    limit:   int = 200,
    offset:  int = 0,
    user=Depends(get_current_user)
):
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute("""
            SELECT id, station, type, message, user_name, timestamp
            FROM system_logs
            ORDER BY timestamp DESC
            LIMIT %s OFFSET %s
        """, (min(limit, 500), offset))
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
        cur.execute(
            "UPDATE users SET token_version = token_version + 1 WHERE id = %s",
            (user_id,)
        )
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
    return {"ok": True}

# --- FEWS UNITS ---

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

# --- SIREN CONTROL ---

@app.post("/siren/{device_id}")
def control_siren(device_id: str, req: SirenRequest, user=Depends(get_current_user)):
    from mqtt_bridge import publish_siren
    publish_siren(device_id, req.state)
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute(
            "UPDATE fews_units SET siren_state = %s WHERE device_id = %s",
            (req.state == "on", device_id)
        )
        conn.commit()
    finally:
        cur.close()
        release_db(conn)
    return {"ok": True}