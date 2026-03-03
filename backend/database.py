import psycopg2
import psycopg2.extras
import os

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://cdrrmo_admin:wvBRk5TLHSI50DY6LbcFMzx9hwOboYWm@dpg-d6j5mtffte5s73da3vgg-a.singapore-postgres.render.com/cdrrmo_fews"
)

def get_db():
    conn = psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    return conn

def init_db():
    conn = get_db()
    cur  = conn.cursor()

    # Users table — stores login credentials + role
    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id         SERIAL PRIMARY KEY,
            name       TEXT NOT NULL,
            email      TEXT UNIQUE NOT NULL,
            password   TEXT NOT NULL,
            role       TEXT NOT NULL DEFAULT 'Viewer',
            department TEXT NOT NULL DEFAULT 'Operations',
            created_at TIMESTAMP DEFAULT NOW()
        )
    """)

    # FEWS sensor readings table
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

    conn.commit()
    cur.close()
    conn.close()