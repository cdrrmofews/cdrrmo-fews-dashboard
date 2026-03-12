import psycopg2
import psycopg2.extras
import psycopg2.pool
import os

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres.psxuwsogetsxcwgdkcxp:NTs4yXh2aezi5yVL@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres"
)

# Connection pool: min 1, max 5 connections
_pool = None

def get_pool():
    global _pool
    if _pool is None:
        _pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=0,
            maxconn=10,
            dsn=DATABASE_URL + "?connect_timeout=10",
            cursor_factory=psycopg2.extras.RealDictCursor
        )
    return _pool

def get_db():
    pool = get_pool()
    conn = pool.getconn()
    # Reset connection state to avoid stale connections
    conn.autocommit = False
    return conn

def release_db(conn):
    try:
        pool = get_pool()
        pool.putconn(conn)
    except Exception:
        pass

def init_db():
    conn = get_db()
    cur  = conn.cursor()
    try:
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
    except Exception as e:
        conn.rollback()
        print(f"[DB] init_db error: {e}")
    finally:
        cur.close()
        release_db(conn)