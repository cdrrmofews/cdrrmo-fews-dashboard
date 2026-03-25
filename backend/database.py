import psycopg2
import psycopg2.extras
import psycopg2.pool
import os
import time
import threading

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("[DB] DATABASE_URL environment variable is not set")

_pool = None
_pool_fail_count = 0
_pool_lock = threading.Lock()
_resetting = False
MAX_POOL_FAILS = 3

def get_pool():
    global _pool
    if _pool is not None:
        return _pool
    _pool = psycopg2.pool.ThreadedConnectionPool(
        minconn=1,
        maxconn=5,
        dsn=DATABASE_URL + "?connect_timeout=30",
        cursor_factory=psycopg2.extras.RealDictCursor
    )
    print("[DB] Connection pool created successfully")
    return _pool

def reset_pool():
    global _pool, _pool_fail_count, _resetting
    with _pool_lock:
        if _resetting:
            return
        _resetting = True
        _pool_fail_count = 0

    print("[DB] Resetting connection pool...")
    try:
        with _pool_lock:
            try:
                if _pool is not None:
                    _pool.closeall()
            except Exception:
                pass
            _pool = None

        time.sleep(2)

        with _pool_lock:
            get_pool()
    except Exception as e:
        print(f"[DB] Pool reset failed: {e}")
    finally:
        with _pool_lock:
            _resetting = False

def get_db():
    global _pool_fail_count
    try:
        with _pool_lock:
            pool = get_pool()
            conn = pool.getconn()
        conn.autocommit = False
        with _pool_lock:
            _pool_fail_count = 0
        return conn
    except psycopg2.pool.PoolError as e:
        print(f"[DB] Pool exhausted: {e}")
        raise psycopg2.OperationalError("Database pool exhausted, try again shortly")
    except psycopg2.OperationalError as e:
        with _pool_lock:
            _pool_fail_count += 1
            count = _pool_fail_count
            should_reset = count >= MAX_POOL_FAILS and not _resetting
        print(f"[DB] Connection failed ({count}/{MAX_POOL_FAILS}): {e}")
        if should_reset:
            print("[DB] Too many failures — forcing pool reset")
            t = threading.Thread(target=reset_pool, daemon=True)
            t.start()
        raise
    except Exception as e:
        print(f"[DB] Unexpected error getting connection: {e}")
        raise

def release_db(conn):
    if conn is None:
        return
    try:
        if not conn.closed:
            try:
                conn.rollback()
            except Exception:
                pass
        with _pool_lock:
            pool = get_pool()
            pool.putconn(conn)
    except Exception as e:
        print(f"[DB] Failed to release connection: {e}")
        try:
            conn.close()
        except Exception:
            pass

def close_pool():
    global _pool
    with _pool_lock:
        if _pool is not None:
            try:
                _pool.closeall()
                print("[DB] Connection pool closed")
            except Exception as e:
                print(f"[DB] Error closing pool: {e}")
            finally:
                _pool = None

def init_db():
    conn = None
    for attempt in range(3):
        try:
            conn = get_db()
            break
        except psycopg2.OperationalError as e:
            print(f"[DB] init_db attempt {attempt + 1}/3 failed: {e}")
            if attempt < 2:
                time.sleep(5)
            else:
                print("[DB] init_db giving up — DB unavailable at startup")
                return

    cur = conn.cursor()
    try:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id            SERIAL PRIMARY KEY,
                name          TEXT NOT NULL,
                email         TEXT UNIQUE NOT NULL,
                password      TEXT NOT NULL,
                role          TEXT NOT NULL DEFAULT 'Viewer',
                department    TEXT NOT NULL DEFAULT 'Operations',
                photo         TEXT,
                token_version INTEGER NOT NULL DEFAULT 0,
                created_at    TIMESTAMP DEFAULT NOW()
            )
        """)
        cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS photo TEXT")
        cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sensor_readings (
                id             SERIAL PRIMARY KEY,
                device_id      TEXT NOT NULL,
                water_level_cm REAL,
                battery_pct    REAL,
                status         TEXT,
                latitude       REAL,
                longitude      REAL,
                is_immediate   BOOLEAN NOT NULL DEFAULT FALSE,
                timestamp      TIMESTAMP DEFAULT NOW()
            )
        """)
        cur.execute("ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS is_immediate BOOLEAN NOT NULL DEFAULT FALSE")
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
        cur.execute("CREATE INDEX IF NOT EXISTS idx_logs_ts ON system_logs (timestamp DESC)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_readings_ts ON sensor_readings (device_id, timestamp DESC)")
        cur.execute("ALTER TABLE system_logs ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL")
        conn.commit()
        print("[DB] Tables initialized successfully")
    except Exception as e:
        conn.rollback()
        print(f"[DB] init_db error: {e}")
    finally:
        cur.close()
        release_db(conn)