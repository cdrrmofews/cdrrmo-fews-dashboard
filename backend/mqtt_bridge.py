import json
import uuid
import threading
import requests
import time
import paho.mqtt.client as mqtt
import paho.mqtt.publish as mqtt_publish
from database import get_db, release_db

# ─── SEMAPHORE SMS ────────────────────────────────────────────────────────────
import os
SEMAPHORE_API_KEY = os.environ.get("SEMAPHORE_API_KEY")
if not SEMAPHORE_API_KEY:
    raise RuntimeError("[SMS] SEMAPHORE_API_KEY environment variable is not set")
SEMAPHORE_SENDER  = "CDRRMO"
_last_sms_time = 0

def send_sms_to_all():
    try:
        conn = get_db()
        cur  = conn.cursor()
        try:
            cur.execute("SELECT name, phone FROM users WHERE sms_enabled = TRUE AND phone IS NOT NULL AND phone != ''")
            recipients = cur.fetchall()
        finally:
            cur.close()
            release_db(conn)

        if not recipients:
            print("[SMS] No recipients with SMS enabled — skipping")
            return

        message = "CDRRMO ALERT: Water level has reached CRITICAL status. Immediate action may be required."
        for row in recipients:
            name, phone = row["name"], row["phone"]
            try:
                resp = requests.post(
                    "https://api.semaphore.co/api/v4/messages",
                    data={
                        "apikey":     SEMAPHORE_API_KEY,
                        "number":     phone,
                        "message":    message,
                        "sendername": SEMAPHORE_SENDER,
                    },
                    timeout=10,
                )
                print(f"[SMS] Sent to {name} ({phone}): HTTP {resp.status_code}")
            except Exception as e:
                print(f"[SMS] Failed to send to {name} ({phone}): {e}")

    except Exception as e:
        print(f"[SMS] send_sms_to_all failed entirely: {e}")

MQTT_BROKER        = "broker.emqx.io"
MQTT_PORT          = 1883
MQTT_TOPIC         = "cdrrmo/fews1/data"
MQTT_STATUS_TOPIC  = "cdrrmo/fews1/status"

# In-memory last online timestamp per station
_last_online: dict = {}

def mark_station_online(station_id: str):
    _last_online[station_id] = time.time()

def get_last_online(station_id: str) -> float:
    return _last_online.get(station_id, 0)

def water_level_to_type(water_level_cm):
    if water_level_cm is None:
        return "info"
    if water_level_cm > 300:
        return "danger"
    if water_level_cm > 200:
        return "warning"
    return "info"

def water_level_to_status_label(water_level_cm):
    if water_level_cm is None:
        return "UNKNOWN"
    if water_level_cm > 300:
        return "CRITICAL"
    if water_level_cm > 200:
        return "WARNING"
    if water_level_cm > 0:
        return "SAFE"
    return "NORMAL"

def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print("[BRIDGE] Connected to broker")
        result, mid = client.subscribe(MQTT_TOPIC, qos=0)
        print(f"[BRIDGE] Subscribed to {MQTT_TOPIC} result={result} mid={mid}")
        result2, mid2 = client.subscribe(MQTT_STATUS_TOPIC, qos=0)
        print(f"[BRIDGE] Subscribed to {MQTT_STATUS_TOPIC} result={result2} mid={mid2}")
    else:
        print(f"[BRIDGE] Connection failed rc={rc}")

def on_message(client, userdata, msg):
    try:
        data = json.loads(msg.payload.decode())
        print(f"[BRIDGE] Received on {msg.topic}: {data}")

        # ── Handle startup status message ─────────────────────────────────
        if msg.topic == MQTT_STATUS_TOPIC:
            if data.get("online") and data.get("station_id"):
                station_id = data.get("station_id")
                mark_station_online(station_id)
                conn = get_db()
                cur  = conn.cursor()
                try:
                    cur.execute("""
                        INSERT INTO system_logs (station, type, message, user_name)
                        VALUES (%s, %s, %s, %s)
                    """, (
                        "FEWS 1",
                        "system",
                        "FEWS 1 is online and transmitting data",
                        "System",
                    ))
                    conn.commit()
                    print("[BRIDGE] Startup status logged")
                finally:
                    cur.close()
                    release_db(conn)
            return

        station_id     = data.get("station_id")
        water_level_cm = data.get("water_level_cm")
        battery_pct    = data.get("battery_pct")
        status         = data.get("status")
        latitude       = data.get("latitude")
        longitude      = data.get("longitude")
        is_immediate   = data.get("is_immediate", False)

        conn = get_db()
        cur  = conn.cursor()
        try:
            cur.execute("""
                INSERT INTO sensor_readings
                    (device_id, water_level_cm, battery_pct, status, latitude, longitude, is_immediate)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
            """, (
                station_id,
                water_level_cm,
                battery_pct,
                status,
                latitude,
                longitude,
                is_immediate,
            ))

            log_type     = water_level_to_type(water_level_cm)
            status_label = water_level_to_status_label(water_level_cm)
            station_name = "FEWS 1"
            battery_str  = f"{battery_pct}%" if battery_pct is not None else "N/A"
            water_str    = f"{water_level_cm} cm" if water_level_cm is not None else "N/A"

            log_message = (
                f"{station_name} reading — "
                f"Water Level: {water_str} [{status_label}] · "
                f"Battery: {battery_str}"
            )

            cur.execute("""
                INSERT INTO system_logs (station, type, message, user_name)
                VALUES (%s, %s, %s, %s)
            """, (
                station_name,
                log_type,
                log_message,
                "System",
            ))

            conn.commit()
            mark_station_online(station_id)
            print(f"[BRIDGE] Saved → {station_id} {water_level_cm}cm {status} is_immediate={is_immediate} | Logged as [{log_type.upper()}]")
            
            if log_type == "danger":
                            import time
                            global _last_sms_time
                            if time.time() - _last_sms_time > 600:
                                _last_sms_time = time.time()
                                threading.Thread(target=send_sms_to_all, daemon=True).start()
                            else:
                                remaining = int(600 - (time.time() - _last_sms_time))
                                print(f"[SMS] Cooldown active — {remaining}s remaining before next blast")
        finally:
            cur.close()
            release_db(conn)

    except Exception as e:
        print(f"[BRIDGE] Error: {e}")

def on_disconnect(client, userdata, rc):
    if rc != 0:
        print(f"[BRIDGE] Unexpected disconnect rc={rc}, will auto-reconnect")

def start_bridge():
    while True:
        try:
            unique_id = f"cdrrmo_bridge_{uuid.uuid4().hex[:8]}"
            print(f"[BRIDGE] Client ID: {unique_id}")
            client = mqtt.Client(client_id=unique_id, protocol=mqtt.MQTTv311, clean_session=True)
            client.on_connect    = on_connect
            client.on_message    = on_message
            client.on_disconnect = on_disconnect
            client.reconnect_delay_set(min_delay=1, max_delay=30)
            client.connect(MQTT_BROKER, MQTT_PORT, keepalive=60)
            client.loop_forever()
        except Exception as e:
            print(f"[BRIDGE] Crashed: {e} — restarting in 5s")
            time.sleep(5)

def start_bridge_thread():
    t = threading.Thread(target=start_bridge, daemon=True)
    t.start()
    print("[BRIDGE] Thread started")

# ── NEW: Publish siren command to Arduino ─────────────────────────────────────
def publish_siren(device_id: str, state: str):
    topic   = f"cdrrmo/{device_id}/siren"
    payload = json.dumps({"siren": state})
    try:
        mqtt_publish.single(
            topic,
            payload=payload,
            hostname=MQTT_BROKER,
            port=MQTT_PORT,
            protocol=mqtt.MQTTv311,
        )
        print(f"[SIREN] Published '{state}' to {topic}")
    except Exception as e:
        print(f"[SIREN] Failed to publish: {e}")
# ─────────────────────────────────────────────────────────────────────────────