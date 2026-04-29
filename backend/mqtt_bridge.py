import json
import uuid
import threading
import time
import paho.mqtt.client as mqtt
import paho.mqtt.publish as mqtt_publish
from database import get_db, release_db

def send_sms_to_all():
    pass

MQTT_BROKER             = "broker.emqx.io"
MQTT_PORT               = 1883
MQTT_TOPIC              = "cdrrmo/fews1/data"
MQTT_STATUS_TOPIC       = "cdrrmo/fews1/status"
MQTT_SIREN_STATUS_TOPIC = "cdrrmo/fews1/siren_status"
MQTT_HEARTBEAT_TOPIC    = "cdrrmo/fews1/heartbeat"
OFFLINE_TIMEOUT         = 150  # 2.5 minutes in seconds

# In-memory last online timestamp per station
_last_online: dict = {}
_offline_logged: dict = {}

def mark_station_online(station_id: str):
    _last_online[station_id] = time.time()
    _offline_logged[station_id] = False  # reset so next dropout gets logged

def get_last_online(station_id: str) -> float:
    return _last_online.get(station_id, 0)

def start_offline_watcher():
    """Background thread — logs when a station stops sending heartbeats for 2.5 minutes."""
    def watch():
        while True:
            time.sleep(30)  # check every 30 seconds
            now = time.time()
            for station_id, last in list(_last_online.items()):
                age = now - last
                already_logged = _offline_logged.get(station_id, False)
                if age >= OFFLINE_TIMEOUT and not already_logged:
                    _offline_logged[station_id] = True
                    station_name = "FEWS 1" if station_id == "fews_1" else station_id
                    try:
                        conn = get_db()
                        cur  = conn.cursor()
                        try:
                            cur.execute("""
                                INSERT INTO system_logs (station, type, message, user_name)
                                VALUES (%s, %s, %s, %s)
                            """, (
                                station_name,
                                "warning",
                                f"{station_name} went offline — no heartbeat received for 2.5 minutes",
                                "System",
                            ))
                            conn.commit()
                            print(f"[WATCHER] Offline logged for {station_id}")
                        finally:
                            cur.close()
                            release_db(conn)
                    except Exception as e:
                        print(f"[WATCHER] Error logging offline: {e}")
                elif age < OFFLINE_TIMEOUT and already_logged:
                    # Reset so next offline event gets logged again
                    _offline_logged[station_id] = False

    t = threading.Thread(target=watch, daemon=True)
    t.start()
    print("[WATCHER] Offline watcher thread started (2.5 min timeout)")

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
        result3, mid3 = client.subscribe(MQTT_SIREN_STATUS_TOPIC, qos=0)
        print(f"[BRIDGE] Subscribed to {MQTT_SIREN_STATUS_TOPIC} result={result3} mid={mid3}")
        result4, mid4 = client.subscribe(MQTT_HEARTBEAT_TOPIC, qos=0)
        print(f"[BRIDGE] Subscribed to {MQTT_HEARTBEAT_TOPIC} result={result4} mid={mid4}")
    else:
        print(f"[BRIDGE] Connection failed rc={rc}")

def on_message(client, userdata, msg):
    try:
        data = json.loads(msg.payload.decode())
        print(f"[BRIDGE] Received on {msg.topic}: {data}")

        # ── Handle heartbeat ──────────────────────────────────────────────────────
        if msg.topic == MQTT_HEARTBEAT_TOPIC:
            station_id = data.get("station_id")
            if station_id:
                mark_station_online(station_id)
                print(f"[HB] Heartbeat received from {station_id}")
            return

        # ── Handle siren auto-off from Arduino ────────────────────────────────────
        if msg.topic == MQTT_SIREN_STATUS_TOPIC:
                if data.get("siren_auto_off") and data.get("station_id"):
                    sid = data.get("station_id")
                    station_name = "FEWS 1"
                    try:
                        conn = get_db()
                        cur  = conn.cursor()
                        try:
                            cur.execute(
                                "UPDATE fews_units SET siren_state = FALSE, siren_auto_triggered = FALSE WHERE device_id = %s AND siren_auto_triggered = TRUE RETURNING siren_state",
                                (sid,)
                            )
                            conn.commit()
                            if cur.rowcount > 0:
                                print(f"[BRIDGE] Siren auto-off synced for {sid}")
                                cur.execute("""
                                    INSERT INTO system_logs (station, type, message, user_name)
                                    VALUES (%s, %s, %s, %s)
                                """, (
                                    station_name,
                                    "system",
                                    f"{station_name} siren has been automatically silenced by the device — water level returned to safe",
                                    "System",
                                ))
                                conn.commit()
                            else:
                                print(f"[BRIDGE] Siren auto-off received — already cleared for {sid}, skipping log")
                            print(f"[BRIDGE] Siren auto-off logged for {sid}")
                        finally:
                            cur.close()
                            release_db(conn)
                    except Exception as e:
                        print(f"[BRIDGE] Siren auto-off DB error: {e}")
                return

        # ── Handle startup status message ─────────────────────────────────
        if msg.topic == MQTT_STATUS_TOPIC:
            if data.get("online") and data.get("station_id"):
                station_id   = data.get("station_id")
                station_name = "FEWS 1"
                was_online   = get_last_online(station_id)
                mark_station_online(station_id)

                conn = get_db()
                cur  = conn.cursor()
                try:
                    # If was offline before (last_seen > 10 min ago or never seen), log comeback
                    age = time.time() - was_online if was_online else None
                    if age is None or age >= OFFLINE_TIMEOUT:
                        cur.execute("""
                            INSERT INTO system_logs (station, type, message, user_name)
                            VALUES (%s, %s, %s, %s)
                        """, (
                            station_name,
                            "system",
                            f"{station_name} is online and transmitting data",
                            "System",
                        ))
                    conn.commit()
                    print("[BRIDGE] Startup status logged")
                finally:
                    cur.close()
                    release_db(conn)
            return

        station_id          = data.get("station_id")
        water_level_cm      = data.get("water_level_cm")
        status              = data.get("status")
        latitude            = data.get("latitude")
        longitude           = data.get("longitude")
        is_immediate        = data.get("is_immediate", False)
        safe_after_critical = data.get("safe_after_critical", False)

        conn = get_db()
        cur  = conn.cursor()
        try:
            cur.execute("""
                INSERT INTO sensor_readings
                    (device_id, water_level_cm, status, latitude, longitude, is_immediate)
                VALUES (%s, %s, %s, %s, %s, %s)
            """, (
                station_id,
                water_level_cm,
                status,
                latitude,
                longitude,
                is_immediate,
            ))

            threshold_warning, threshold_danger = get_thresholds(station_id)
            log_type     = water_level_to_type(water_level_cm, threshold_warning, threshold_danger)
            status_label = water_level_to_status_label(water_level_cm, threshold_warning, threshold_danger)
            station_name = "FEWS 1"
            water_str    = f"{water_level_cm} cm" if water_level_cm is not None else "N/A"

            log_message = (
                f"{station_name} reading — "
                f"Water Level: {water_str} [{status_label}]"
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

            # Auto-siren ON: after 2min CRITICAL — skip if manually silenced or already active
            if is_immediate and status == "CRITICAL":
                try:
                    cur.execute(
                        "SELECT siren_manual_off, siren_state, siren_auto_triggered FROM fews_units WHERE device_id = %s",
                        (station_id,)
                    )
                    unit_row = cur.fetchone()
                    if unit_row and unit_row["siren_manual_off"]:
                        cur.execute(
                            "UPDATE fews_units SET siren_manual_off = FALSE WHERE device_id = %s",
                            (station_id,)
                        )
                        conn.commit()
                        unit_row = dict(unit_row)
                        unit_row["siren_manual_off"] = False
                        print(f"[BRIDGE] siren_manual_off cleared — new critical event for {station_id}")

                    if unit_row and unit_row["siren_auto_triggered"]:
                        print(f"[BRIDGE] Auto-siren already active for {station_id}, skipping duplicate log")
                    elif unit_row and unit_row["siren_state"] and not unit_row["siren_auto_triggered"]:
                        print(f"[BRIDGE] Auto-siren skipped — siren already manually ON for {station_id}")
                    else:
                        cur.execute(
                            "UPDATE fews_units SET siren_state = TRUE, siren_auto_triggered = TRUE WHERE device_id = %s",
                            (station_id,)
                        )
                        cur.execute("""
                            INSERT INTO system_logs (station, type, message, user_name)
                            VALUES (%s, %s, %s, %s)
                        """, (
                            station_name,
                            "warning",
                            f"{station_name} siren has been automatically activated due to sustained CRITICAL water level",
                            "System",
                        ))
                        conn.commit()
                        print(f"[BRIDGE] Auto-siren ON written to DB for {station_id}")
                except Exception as e:
                    print(f"[BRIDGE] Failed to write auto-siren state: {e}")

            # Auto-siren OFF: only clear on the confirmed safe-after-critical publish
            safe_after_critical = data.get("safe_after_critical", False)
            if status != "CRITICAL" and safe_after_critical:
                try:
                    cur.execute(
                        "SELECT siren_auto_triggered, siren_state FROM fews_units WHERE device_id = %s",
                        (station_id,)
                    )
                    prev = cur.fetchone()
                    cur.execute(
                        "UPDATE fews_units SET siren_manual_off = FALSE, siren_state = FALSE, siren_auto_triggered = FALSE WHERE device_id = %s",
                        (station_id,)
                    )
                    conn.commit()

                    was_siren_on = prev and prev["siren_state"]   # covers BOTH manual and auto

                    if was_siren_on:
                        cur.execute("""
                            INSERT INTO system_logs (station, type, message, user_name)
                            VALUES (%s, %s, %s, %s)
                        """, (
                            station_name, "system",
                            f"{station_name} siren has been automatically silenced — water level returned to {status_label}",
                            "System",
                        ))
                        conn.commit()
                    print(f"[BRIDGE] Auto-siren OFF cleared for {station_id}")
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
    start_offline_watcher()

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