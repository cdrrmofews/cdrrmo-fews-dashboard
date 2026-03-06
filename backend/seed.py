from database import get_db, init_db
from auth import hash_password

ADMIN_NAME       = "John Doe"
ADMIN_EMAIL      = "johndoe@cdrrmo.gov.ph"
ADMIN_PASSWORD   = "cdrrmo2026"
ADMIN_ROLE       = "Admin"
ADMIN_DEPARTMENT = "Operations"

def seed():
    print("Initializing database tables...")
    init_db()

    conn = get_db()
    cur  = conn.cursor()

    cur.execute("SELECT id FROM users WHERE email = %s", (ADMIN_EMAIL,))
    if cur.fetchone():
        print(f"Admin user '{ADMIN_EMAIL}' already exists. Skipping.")
        cur.close()
        conn.close()
        return

    cur.execute("""
        INSERT INTO users (name, email, password, role, department)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING id
    """, (ADMIN_NAME, ADMIN_EMAIL, hash_password(ADMIN_PASSWORD), ADMIN_ROLE, ADMIN_DEPARTMENT))

    conn.commit()
    user_id = cur.fetchone()["id"]
    print(f"✅ Admin user created!")
    print(f"   ID:       {user_id}")
    print(f"   Name:     {ADMIN_NAME}")
    print(f"   Email:    {ADMIN_EMAIL}")
    print(f"   Password: {ADMIN_PASSWORD}")
    print(f"   Role:     {ADMIN_ROLE}")
    print()
    print("⚠️  Remember to change the password after your first login!")
    print()
    print("ℹ️  System roles: Admin (full access), Operator (Dashboard, Logs, Settings)")

    cur.close()
    conn.close()

if __name__ == "__main__":
    seed()