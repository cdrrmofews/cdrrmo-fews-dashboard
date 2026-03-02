from passlib.context import CryptContext
from jose import jwt
from datetime import datetime, timedelta
from database import get_db

SECRET_KEY = "change-this-to-a-random-secret"
ALGORITHM = "HS256"
pwd_context = CryptContext(schemes=["bcrypt"])

def hash_password(password: str):
    return pwd_context.hash(password)

def verify_password(plain: str, hashed: str):
    return pwd_context.verify(plain, hashed)

def create_token(username: str):
    expire = datetime.utcnow() + timedelta(hours=8)
    return jwt.encode({"sub": username, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)

def authenticate_user(username: str, password: str):
    conn = get_db()
    user = conn.execute(
        "SELECT * FROM users WHERE username = ?", (username,)
    ).fetchone()
    conn.close()
    if not user or not verify_password(password, user["password_hash"]):
        return None
    return user