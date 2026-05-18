import bcrypt
import jwt
import os
from datetime import datetime, timedelta, timezone

SECRET_KEY = os.environ.get("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("[AUTH] SECRET_KEY environment variable is not set")
ALGORITHM = "HS256"

def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()

def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())

def create_token(user_id: int, role: str, token_version: int = 0) -> str:
    payload = {
        "sub":           str(user_id),
        "role":          role,
        "token_version": token_version,
        "exp":           datetime.now(timezone.utc) + timedelta(hours=12),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def decode_token(token: str) -> dict:
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])