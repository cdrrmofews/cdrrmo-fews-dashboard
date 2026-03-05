import json
import uuid
import threading
import paho.mqtt.client as mqtt
from database import get_db

MQTT_BROKER = "broker.emqx.io"
MQTT_PORT   = 1883
MQTT_TOPIC  = "cdrrmo/fews1/data"

def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print("[BRIDGE] Connected to broker")
        result, mid = client.subscribe(MQTT_TOPIC, qos=0)
        print(f"[BRIDGE] Subscribed to {MQTT_TOPIC} result={result} mid={mid}")
    else:
        print(f"[BRIDGE] Connection failed rc={rc}")

def on_message(client, userdata, msg):
    try:
        data = json.loads(msg.payload.decode())
        print(f"[BRIDGE] Received: {data}")

        conn = get_db()
        cur  = conn.cursor()
        try:
            cur.execute("""
                INSERT INTO sensor_readings
                    (device_id, water_level_cm, battery_pct, status, latitude, longitude)
                VALUES (%s, %s, %s, %s, %s, %s)
            """, (
                data.get("station_id"),
                data.get("water_level_cm"),
                data.get("battery_pct"),
                data.get("status"),
                data.get("latitude"),
                data.get("longitude"),
            ))
            conn.commit()
            print(f"[BRIDGE] Saved → {data.get('station_id')} {data.get('water_level_cm')}cm {data.get('status')}")
        finally:
            cur.close()
            conn.close()

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