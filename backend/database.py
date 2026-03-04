import psycopg2
import psycopg2.extras
import os

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres.psxuwsogetsxcwgdkcxp:NTs4yXh2aezi5yVL@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"
)

def get_db():
    conn = psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    return conn

def init_db():
    conn = get_db()
    cur  = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id         SERIAL PRIMARY KEY,
            name       TEXT NOT NULL,
            email      TEXT UNIQUE NOT NULL,
            password   TEXT NOT NULL,
            role       TEXT NOT NULL DEFAULT 'Viewer',
            department TEXT NOT NULL DEFAULT 'Operations',
            photo      TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )
    """)

    cur.execute("""
        ALTER TABLE users ADD COLUMN IF NOT EXISTS photo TEXT
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS sensor_readings (
            id             SERIAL PRIMARY KEY,
            device_id      TEXT NOT NULL,
            water_level_cm REAL,
            battery_pct    REAL,
            status         TEXT,
            latitude       REAL,
            longitude      REAL,
            timestamp      TIMESTAMP DEFAULT NOW()
        )
    """)

    # NEW: system_logs table
    cur.execute("""
        CREATE TABLE IF NOT EXISTS system_logs (
            id        SERIAL PRIMARY KEY,
            station   TEXT NOT NULL DEFAULT 'System',
            type      TEXT NOT NULL DEFAULT 'system',
            message   TEXT NOT NULL,
            user_name TEXT,
            timestamp TIMESTAMP DEFAULT NOW()
        )
    """)

    conn.commit()
    cur.close()
    conn.close()