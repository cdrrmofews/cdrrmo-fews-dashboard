import json
import uuid
import threading
import time
import paho.mqtt.client as mqtt
import paho.mqtt.publish as mqtt_publish
from database import get_db, release_db

def send_sms_to_all():
    pass

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

def get_thresholds(device_id="fews_1"):
    try:
        conn = get_db()
        cur  = conn.cursor()
        try:
            cur.execute(
                "SELECT threshold_warning, threshold_danger FROM fews_units WHERE device_id = %s",
                (device_id,)
            )
            row = cur.fetchone()
            if row:
                return row["threshold_warning"], row["threshold_danger"]
        finally:
            cur.close()
            release_db(conn)
    except Exception as e:
        print(f"[THRESHOLDS] Failed to fetch: {e}")
    return 200, 300  # fallback defaults

def water_level_to_type(water_level_cm, threshold_warning=200, threshold_danger=300):
    if water_level_cm is None:
        return "info"
    if water_level_cm > threshold_danger:
        return "danger"
    if water_level_cm > threshold_warning:
        return "warning"
    return "info"

def water_level_to_status_label(water_level_cm, threshold_warning=200, threshold_danger=300):
    if water_level_cm is None:
        return "UNKNOWN"
    if water_level_cm > threshold_danger:
        return "CRITICAL"
    if water_level_cm > threshold_warning:
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

            threshold_warning, threshold_danger = get_thresholds(station_id)
            log_type     = water_level_to_type(water_level_cm, threshold_warning, threshold_danger)
            status_label = water_level_to_status_label(water_level_cm, threshold_warning, threshold_danger)
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
                print("[SMS] CRITICAL detected — SMS handled by Arduino directly")

            # Auto-siren ON: after 30s CRITICAL
            if is_immediate and status == "CRITICAL":
                try:
                    cur.execute(
                        "UPDATE fews_units SET siren_state = TRUE, siren_auto_triggered = TRUE WHERE device_id = %s",
                        (station_id,)
                    )
                    conn.commit()
                    print(f"[BRIDGE] Auto-siren ON written to DB for {station_id}")
                except Exception as e:
                    print(f"[BRIDGE] Failed to write auto-siren state: {e}")

            # Auto-siren OFF: only clear if it was auto-triggered, never touch manual
            if status != "CRITICAL":
                try:
                    # First check if an auto-siren is currently active before clearing
                    cur.execute(
                        "SELECT siren_state, siren_auto_triggered FROM fews_units WHERE device_id = %s",
                        (station_id,)
                    )
                    unit_row = cur.fetchone()
                    was_auto_active = (
                        unit_row is not None
                        and unit_row["siren_auto_triggered"] is True
                        and unit_row["siren_state"] is True
                    )

                    cur.execute(
                        "UPDATE fews_units SET siren_state = FALSE, siren_auto_triggered = FALSE WHERE device_id = %s AND siren_auto_triggered = TRUE",
                        (station_id,)
                    )
                    conn.commit()

                    if was_auto_active:
                        publish_siren(station_id, "off")
                        print(f"[BRIDGE] Auto-siren OFF published to Arduino for {station_id}")
                    print(f"[BRIDGE] Auto-siren OFF cleared in DB for {station_id} — status is {status}")
                except Exception as e:
                    print(f"[BRIDGE] Failed to clear auto-siren state: {e}")
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
    topic = "cdrrmo/fews1/siren"
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

def publish_config(device_id: str, threshold_warning: int, threshold_danger: int):
    topic = "cdrrmo/fews1/config"
    payload = json.dumps({"warning": threshold_warning, "danger": threshold_danger})
    try:
        mqtt_publish.single(
            topic,
            payload=payload,
            hostname=MQTT_BROKER,
            port=MQTT_PORT,
            protocol=mqtt.MQTTv311,
        )
        print(f"[CONFIG] Published thresholds warning={threshold_warning} danger={threshold_danger} to {topic}")
    except Exception as e:
        print(f"[CONFIG] Failed to publish: {e}")
# ─────────────────────────────────────────────────────────────────────────────