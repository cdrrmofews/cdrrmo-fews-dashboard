import json
import uuid
import threading
import requests
import paho.mqtt.client as mqtt
import paho.mqtt.publish as mqtt_publish
from database import get_db, release_db

# --- SEMAPHORE SMS ---
SEMAPHORE_API_KEY = "9a340cae60906c4fc591a20a24ace1b7"
SEMAPHORE_SENDER  = "CDRRMO"

def send_sms_to_all():
    conn = get_db()
    cur  = conn.cursor()
    try:
        cur.execute("SELECT name, phone FROM users WHERE sms_enabled = TRUE AND phone IS NOT NULL AND phone != ''")
        recipients = cur.fetchall()
    finally:
        cur.close()
        release_db(conn)

    if not recipients:
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

# --- NEW: Read auto_siren flag from DB ---
def get_auto_siren_enabled():
    conn = None
    try:
        conn = get_db()
        cur  = conn.cursor()
        cur.execute("SELECT auto_siren FROM system_settings LIMIT 1")
        row = cur.fetchone()
        cur.close()
        return row["auto_siren"] if row else True
    except Exception as e:
        print(f"[SETTINGS] Failed to read auto_siren: {e}")
        return True
    finally:
        if conn:
            release_db(conn)

# --- NEW: Publish auto_siren config to Arduino ---
def publish_config(auto_siren: bool):
    topic   = "cdrrmo/fews1/config"
    payload = json.dumps({"auto_siren": auto_siren})
    try:
        mqtt_publish.single(
            topic,
            payload=payload,
            hostname=MQTT_BROKER,
            port=MQTT_PORT,
            protocol=mqtt.MQTTv311,
        )
        print(f"[CONFIG] Published auto_siren={auto_siren} to {topic}")
    except Exception as e:
        print(f"[CONFIG] Failed to publish config: {e}")

MQTT_BROKER = "broker.emqx.io"
MQTT_PORT   = 1883
MQTT_TOPIC  = "cdrrmo/fews1/data"

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
        # NEW: On every connect, immediately sync current config to Arduino
        auto_siren = get_auto_siren_enabled()
        threading.Thread(target=publish_config, args=(auto_siren,), daemon=True).start()
        print(f"[BRIDGE] Synced config to Arduino on connect: auto_siren={auto_siren}")
    else:
        print(f"[BRIDGE] Connection failed rc={rc}")

def on_message(client, userdata, msg):
    try:
        data = json.loads(msg.payload.decode())
        print(f"[BRIDGE] Received: {data}")

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
                f"{station_name} reading -- "
                f"Water Level: {water_str} [{status_label}] - "
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
            print(f"[BRIDGE] Saved -> {station_id} {water_level_cm}cm {status} is_immediate={is_immediate} | Logged as [{log_type.upper()}]")

            if log_type == "danger":
                threading.Thread(target=send_sms_to_all, daemon=True).start()
        finally:
            cur.close()
            release_db(conn)

    except Exception as e:
        print(f"[BRIDGE] Error: {e}")

def on_disconnect(client, userdata, rc):
    if rc != 0:
        print(f"[BRIDGE] Unexpected disconnect rc={rc}, will auto-reconnect")

def start_bridge():
    unique_id = f"cdrrmo_bridge_{uuid.uuid4().hex[:8]}"
    print(f"[BRIDGE] Client ID: {unique_id}")
    client = mqtt.Client(client_id=unique_id, protocol=mqtt.MQTTv311, clean_session=True)
    client.on_connect    = on_connect
    client.on_message    = on_message
    client.on_disconnect = on_disconnect
    client.reconnect_delay_set(min_delay=1, max_delay=30)
    client.connect(MQTT_BROKER, MQTT_PORT, keepalive=60)
    client.loop_forever()

def start_bridge_thread():
    t = threading.Thread(target=start_bridge, daemon=True)
    t.start()
    print("[BRIDGE] Thread started")

# --- Publish siren command to Arduino ---
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