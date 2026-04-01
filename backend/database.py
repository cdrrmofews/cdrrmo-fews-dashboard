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
            old_pool = _pool  # save reference
            print(f"[DB] Destroying old pool id={id(old_pool)}")
            _pool = None

        time.sleep(2)  # let in-flight requests finish

        # NOW close the old pool after requests have had time to complete
        if old_pool is not None:
            try:
                old_pool.closeall()
            except Exception:
                pass

        with _pool_lock:
            get_pool()
            print(f"[DB] New pool id={id(_pool)}")
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
            print(f"[DB] Got conn id={id(conn)} from pool id={id(pool)}")
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
    pool = None
    try:
        if not conn.closed:
            try:
                conn.rollback()
            except Exception:
                pass
        with _pool_lock:
            pool = get_pool()
            print(f"[DB] Releasing conn id={id(conn)} to pool id={id(pool)}")
            print(f"[DB] Pool stats: used={len(pool._used)}, free={len(pool._pool)}")
            pool.putconn(conn)
            print(f"[DB] Released successfully")
    except Exception as e:
        print(f"[DB] Failed to release connection: {e}")
        print(f"[DB] conn id={id(conn)}, pool id={id(pool) if pool else 'None'}")
        if pool is not None:
            try:
                print(f"[DB] conn in pool._used: {id(conn) in [id(c) for c in pool._used.values()]}")
            except Exception:
                pass
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

    if conn is None:
        return

    try:
        print("[DB] Tables initialized successfully")
    finally:
        release_db(conn)