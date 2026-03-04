import os
import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

RENDER_URL = "https://cdrrmo-fews-dashboard.onrender.com/data/ingest"
ARDUINO_SECRET = "fews-secret-2025"

@app.post("/relay")
async def relay(request: Request):
    secret = request.headers.get("x-arduino-secret", "")
    if secret != ARDUINO_SECRET:
        raise HTTPException(status_code=401, detail="Invalid secret")
    body = await request.json()
    async with httpx.AsyncClient() as client:
        resp = await client.post(RENDER_URL, json=body, timeout=30)
    return {"ok": True, "status": resp.status_code}

@app.get("/")
def root():
    return {"status": "relay online"}