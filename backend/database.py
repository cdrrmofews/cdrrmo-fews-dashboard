import sqlite3

DB_PATH = "fews.db"

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()

    # Users table (existing)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT DEFAULT 'operator'
        )
    """)

    # Sensor readings table (new)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sensor_readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            station_id TEXT NOT NULL,
            water_level_cm INTEGER NOT NULL,
            status TEXT NOT NULL,
            battery_pct INTEGER NOT NULL DEFAULT 100,
            latitude REAL NOT NULL DEFAULT 13.7703472,
            longitude REAL NOT NULL DEFAULT 121.0525449,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    conn.commit()
    conn.close()