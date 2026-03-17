import psycopg2
import psycopg2.extras
import psycopg2.pool
import os
import time

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("[DB] DATABASE_URL environment variable is not set")

_pool = None
_pool_fail_count = 0
MAX_POOL_FAILS = 3

def get_pool():
    global _pool, _pool_fail_count
    if _pool is not None:
        return _pool
    try:
        _pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=1,
            maxconn=5,
            dsn=DATABASE_URL + "?connect_timeout=30",
            cursor_factory=psycopg2.extras.RealDictCursor
        )
        _pool_fail_count = 0
        print("[DB] Connection pool created successfully")
        return _pool
    except Exception as e:
        _pool = None
        print(f"[DB] Failed to create connection pool: {e}")
        raise

def reset_pool():
    global _pool, _pool_fail_count
    print("[DB] Resetting connection pool...")
    try:
        if _pool is not None:
            _pool.closeall()
    except Exception:
        pass
    _pool = None
    _pool_fail_count = 0
    time.sleep(2)
    return get_pool()

def get_db():
    global _pool_fail_count
    try:
        pool = get_pool()
        conn = pool.getconn()
        conn.autocommit = False
        _pool_fail_count = 0
        return conn
    except psycopg2.pool.PoolError as e:
        # Pool exhausted — all 5 connections in use
        print(f"[DB] Pool exhausted: {e}")
        raise psycopg2.OperationalError("Database pool exhausted, try again shortly")
    except psycopg2.OperationalError as e:
        _pool_fail_count += 1
        print(f"[DB] Connection failed ({_pool_fail_count}/{MAX_POOL_FAILS}): {e}")
        if _pool_fail_count >= MAX_POOL_FAILS:
            print("[DB] Too many failures — forcing pool reset")
            try:
                reset_pool()
            except Exception as reset_err:
                print(f"[DB] Pool reset also failed: {reset_err}")
        raise
    except Exception as e:
        print(f"[DB] Unexpected error getting connection: {e}")
        raise

def release_db(conn):
    if conn is None:
        return
    try:
        # Roll back any uncommitted transaction before returning to pool
        if not conn.closed:
            try:
                conn.rollback()
            except Exception:
                pass
        pool = get_pool()
        pool.putconn(conn)
    except Exception as e:
        print(f"[DB] Failed to release connection: {e}")
        # If we can't return it to the pool, close it directly
        try:
            conn.close()
        except Exception:
            pass

def close_pool():
    global _pool
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
    retries = 3
    for attempt in range(retries):
        try:
            conn = get_db()
            break
        except psycopg2.OperationalError as e:
            print(f"[DB] init_db connection attempt {attempt + 1}/{retries} failed: {e}")
            if attempt < retries - 1:
                time.sleep(5)
            else:
                print("[DB] init_db giving up after all retries — DB unavailable at startup")
                return

    cur = conn.cursor()
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
                is_immediate   BOOLEAN NOT NULL DEFAULT FALSE,
                timestamp      TIMESTAMP DEFAULT NOW()
            )
        """)

        cur.execute("""
            ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS is_immediate BOOLEAN NOT NULL DEFAULT FALSE
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
        print("[DB] Tables initialized successfully")
    except Exception as e:
        conn.rollback()
        print(f"[DB] init_db error: {e}")
    finally:
        cur.close()
        release_db(conn)