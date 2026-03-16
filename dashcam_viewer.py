#!/usr/bin/env python3
"""DashView - Modern Dashcam Viewer for BlackVue on Linux"""

import os
import re
import json
import struct
import shutil
import mimetypes
import subprocess
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from configparser import ConfigParser, RawConfigParser

from flask import (
    Flask, render_template, jsonify, request, send_file,
    Response, abort
)

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024

# Default dashcam folder - can be overridden via env or UI
DASHCAM_ROOT = os.environ.get('DASHCAM_ROOT', os.path.expanduser('~/dashcam'))

# Settings file location
SETTINGS_FILE = os.path.join(os.path.expanduser('~'), '.config', 'dashview', 'settings.json')

DEFAULT_SETTINGS = {
    'overlay_gps': True,
    'overlay_speed': True,
    'overlay_gsensor': True,
    'overlay_minimap': True,
    'overlay_coordinates': True,
    'overlay_heading': True,
    'overlay_altitude': False,
    'overlay_opacity': 0.85,
    'overlay_position': 'bottom-left',
    'overlay_scale': 1.0,
    'speed_unit': 'kmh',
    'minimap_size': 200,
    'minimap_zoom': 16,
    'gsensor_graph_height': 160,
    'gsensor_overlay_position': 'top-right',
    'auto_play_next': True,
    'show_thumbnails': True,
    'show_preview_strip': False,
    'auto_build_gps_cache': False,
    'theme': 'auto',
}

# BlackVue file pattern: YYYYMMDD_HHMMSS_TT.mp4
# TT codes: NF/NR (Normal), EF/ER (Event), PF/PR (Parking),
#            MF/MR (Manual), IF/IR (Impact)
FILE_PATTERN = re.compile(
    r'^(\d{8})_(\d{6})_([NEPMITB][FR])\.mp4$', re.IGNORECASE
)

TYPE_LABELS = {
    'NF': 'Normal (Front)', 'NR': 'Normal (Rear)',
    'EF': 'Event (Front)',  'ER': 'Event (Rear)',
    'PF': 'Parking (Front)', 'PR': 'Parking (Rear)',
    'MF': 'Manual (Front)', 'MR': 'Manual (Rear)',
    'IF': 'Impact (Front)', 'IR': 'Impact (Rear)',
    'TF': 'Timelapse (Front)', 'TR': 'Timelapse (Rear)',
    'BF': 'Buffered (Front)', 'BR': 'Buffered (Rear)',
}

TYPE_CATEGORIES = {
    'N': 'normal', 'E': 'event', 'P': 'parking',
    'M': 'manual', 'I': 'impact', 'T': 'timelapse',
    'B': 'buffered',
}

# ============================================================
# Dashcam Config Schema - descriptions and valid values
# for BlackVue DR900S / DR900X / DR770X series
#
# Reorganized into user-facing categories. Each setting has a
# '_section' field mapping it back to the original config.ini
# section (Tab1, Tab2, Tab3, Wifi, Cloud) for read/write.
# ============================================================
CONFIG_SCHEMA = {
    'video': {
        '_label': 'Video & Image',
        '_description': 'Resolution, quality, codec, and image processing',
        'ImageSetting':    {'_section': 'Tab1', 'label': 'Resolution', 'description': 'Video resolution for front and rear cameras. Higher resolution uses more storage.', 'type': 'select', 'options': {0: 'Highest (4K UHD Front + Full HD Rear)', 1: 'High (Full HD Front + Full HD Rear)', 2: 'Medium (Full HD Front + HD Rear)'}},
        'VideoQuality':    {'_section': 'Tab1', 'label': 'Video Bitrate Quality', 'description': 'Video encoding bitrate. Higher quality produces clearer video but larger files.', 'type': 'select', 'options': {0: 'Highest', 1: 'High', 2: 'Normal'}},
        'VCodecType':      {'_section': 'Tab1', 'label': 'Video Codec', 'description': 'H.265 (HEVC) produces smaller files at the same quality but requires more processing power for playback.', 'type': 'select', 'options': {0: 'H.264 (AVC)', 1: 'H.265 (HEVC)'}},
        'HDR':             {'_section': 'Tab1', 'label': 'HDR (High Dynamic Range)', 'description': 'Improves detail in high-contrast scenes (bright sky + dark shadows). May introduce slight ghosting on fast-moving objects.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'NightVision':     {'_section': 'Tab1', 'label': 'Night Vision', 'description': 'Enhanced low-light video processing. Brightens dark scenes for better nighttime footage.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'FrontBrightness': {'_section': 'Tab1', 'label': 'Front Camera Brightness', 'description': 'Brightness level for the front camera sensor. Adjust if footage appears too dark or washed out.', 'type': 'select', 'options': {0: 'Very Dark (-2)', 1: 'Dark (-1)', 2: 'Normal (0)', 3: 'Bright (+1)', 4: 'Very Bright (+2)'}},
        'RearBrightness':  {'_section': 'Tab1', 'label': 'Rear Camera Brightness', 'description': 'Brightness level for the rear camera sensor.', 'type': 'select', 'options': {0: 'Very Dark (-2)', 1: 'Dark (-1)', 2: 'Normal (0)', 3: 'Bright (+1)', 4: 'Very Bright (+2)'}},
        'FrontRotate':     {'_section': 'Tab1', 'label': 'Rotate Front Camera 180\u00B0', 'description': 'Flip front camera image. Use if the camera is mounted upside-down.', 'type': 'select', 'options': {0: 'Normal', 1: 'Rotated 180\u00B0'}},
        'RearRotate':      {'_section': 'Tab1', 'label': 'Rotate Rear Camera 180\u00B0', 'description': 'Flip rear camera image. Use if the rear camera is mounted upside-down.', 'type': 'select', 'options': {0: 'Normal', 1: 'Rotated 180\u00B0'}},
    },
    'recording': {
        '_label': 'Recording',
        '_description': 'Recording modes, segments, audio, and file management',
        'NormalRecord':    {'_section': 'Tab1', 'label': 'Normal Recording', 'description': 'Enable continuous recording while driving.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'RecordTime':      {'_section': 'Tab1', 'label': 'Clip Length', 'description': 'Duration of each video file. Shorter clips allow finer-grained overwrite but create more files.', 'type': 'select', 'options': {0: '1 minute', 1: '2 minutes', 2: '3 minutes'}},
        'VoiceRecord':     {'_section': 'Tab1', 'label': 'Audio Recording', 'description': 'Record audio from the built-in microphone. Disable for privacy.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'LockEvent':       {'_section': 'Tab1', 'label': 'Lock Event Files', 'description': 'Protect event-triggered recordings from being overwritten by normal recording loop.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'OverwriteLock':   {'_section': 'Tab1', 'label': 'Overwrite Locked Files', 'description': 'Allow overwriting locked event files when SD card is full. Off means locked files are never overwritten (card may fill up).', 'type': 'select', 'options': {0: 'Off (never overwrite locked)', 1: 'On (overwrite oldest locked)'}},
    },
    'parking': {
        '_label': 'Parking Mode',
        '_description': 'Surveillance when the vehicle is parked and engine is off',
        'AutoParking':     {'_section': 'Tab1', 'label': 'Parking Mode', 'description': 'Automatic parking surveillance when the vehicle is stationary. The camera detects engine-off via voltage drop or hardwire kit signals.', 'type': 'select', 'options': {0: 'Off', 1: 'Motion & Impact Detection', 2: 'Time Lapse (1 fps) + Impact Detection', 3: 'Time Lapse (1 fps) Only'}},
        'RearParkingMode': {'_section': 'Tab1', 'label': 'Rear Camera in Parking Mode', 'description': 'Whether the rear camera records during parking mode. Disabling saves storage but you lose rear coverage while parked.', 'type': 'select', 'options': {0: 'Off (front only)', 1: 'On (front + rear)'}},
        'MOTIONSENSOR':    {'_section': 'Tab2', 'label': 'Motion Detection Sensitivity', 'description': 'How sensitive the camera is to visual motion in parking mode. Too high may trigger false events from shadows, rain, or lights.', 'type': 'range', 'min': 0, 'max': 10, 'labels': {0: 'Off'}},
        'FrontMotionRegion': {'_section': 'Tab2', 'label': 'Front Motion Detection Zones', 'description': 'Bitmask defining which image regions trigger motion detection on the front camera. 65535 = all zones. Reduce to ignore trees, flags, etc.', 'type': 'number'},
        'RearMotionRegion': {'_section': 'Tab2', 'label': 'Rear Motion Detection Zones', 'description': 'Bitmask defining which image regions trigger motion detection on the rear camera. 65535 = all zones.', 'type': 'number'},
        'PARKINGSENSOR1':  {'_section': 'Tab2', 'label': 'Parking G-Sensor X (Fwd/Back)', 'description': 'Impact sensitivity for forward/backward while parked. Higher = more sensitive (detects lighter bumps).', 'type': 'range', 'min': 0, 'max': 10, 'labels': {0: 'Off'}},
        'PARKINGSENSOR2':  {'_section': 'Tab2', 'label': 'Parking G-Sensor Y (Left/Right)', 'description': 'Impact sensitivity for left/right while parked.', 'type': 'range', 'min': 0, 'max': 10, 'labels': {0: 'Off'}},
        'PARKINGSENSOR3':  {'_section': 'Tab2', 'label': 'Parking G-Sensor Z (Up/Down)', 'description': 'Impact sensitivity for up/down while parked.', 'type': 'range', 'min': 0, 'max': 10, 'labels': {0: 'Off'}},
        'PARKINGLED':      {'_section': 'Tab3', 'label': 'Parking Mode LED', 'description': 'LED indicator during parking surveillance. Turn off for stealth.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'PARKINGEVENTVOICE': {'_section': 'Tab3', 'label': 'Parking Event Voice Alert', 'description': 'Voice alert when impact or motion is detected while parked.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
    },
    'gsensor': {
        '_label': 'G-Sensor & Events',
        '_description': 'Impact detection sensitivity for normal driving and driving event triggers',
        'NORMALSENSOR1':   {'_section': 'Tab2', 'label': 'Driving G-Sensor X (Fwd/Back)', 'description': 'Impact sensitivity for acceleration/braking while driving. Higher = more sensitive.', 'type': 'range', 'min': 0, 'max': 10, 'labels': {0: 'Off'}},
        'NORMALSENSOR2':   {'_section': 'Tab2', 'label': 'Driving G-Sensor Y (Left/Right)', 'description': 'Impact sensitivity for turns and side impacts while driving.', 'type': 'range', 'min': 0, 'max': 10, 'labels': {0: 'Off'}},
        'NORMALSENSOR3':   {'_section': 'Tab2', 'label': 'Driving G-Sensor Z (Up/Down)', 'description': 'Impact sensitivity for speed bumps and potholes while driving.', 'type': 'range', 'min': 0, 'max': 10, 'labels': {0: 'Off'}},
        'AccelEvent':      {'_section': 'Tab3', 'label': 'Rapid Acceleration Detection', 'description': 'Detect and flag rapid acceleration events in the timeline.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'HarshEvent':      {'_section': 'Tab3', 'label': 'Harsh Braking Detection', 'description': 'Detect and flag hard braking events.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'SharpEvent':      {'_section': 'Tab3', 'label': 'Sharp Turn Detection', 'description': 'Detect and flag aggressive steering/turning events.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
    },
    'overlay': {
        '_label': 'Video Overlay Text',
        '_description': 'Text burned onto the recorded video image',
        'DateDisplay':     {'_section': 'Tab1', 'label': 'Date/Time Stamp', 'description': 'Burn date and time onto the video. Useful as evidence but covers part of the image.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'SpeedUnit':       {'_section': 'Tab1', 'label': 'Speed Display', 'description': 'Show GPS speed on the recorded video.', 'type': 'select', 'options': {0: 'km/h', 1: 'mph', 2: 'Off'}},
        'userString':      {'_section': 'Tab3', 'label': 'Custom Text', 'description': 'Custom text burned onto the video (e.g., license plate, driver name, fleet ID). Leave blank for none.', 'type': 'text', 'placeholder': 'e.g., ABC-1234'},
        'UseGpsInfo':      {'_section': 'Tab1', 'label': 'GPS Data Logging', 'description': 'Record GPS location, speed, and heading alongside video. Required for map features and speed overlay.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
    },
    'speed_alert': {
        '_label': 'Speed Alerts',
        '_description': 'Warn the driver when exceeding a set speed limit',
        'SpeedAlert':      {'_section': 'Tab3', 'label': 'Speed Alert Mode', 'description': 'How to warn when speed limit is exceeded.', 'type': 'select', 'options': {0: 'Off', 1: 'Visual Only', 2: 'Visual + Voice'}},
        'kmLimit':         {'_section': 'Tab3', 'label': 'Speed Limit (km/h)', 'description': 'Threshold in km/h. Set to 0 to disable.', 'type': 'number', 'min': 0, 'max': 300},
        'mileLimit':       {'_section': 'Tab3', 'label': 'Speed Limit (mph)', 'description': 'Threshold in mph. Set to 0 to disable.', 'type': 'number', 'min': 0, 'max': 200},
        'SPEEDALERTVOICE': {'_section': 'Tab3', 'label': 'Speed Alert Voice', 'description': 'Audible warning when the speed limit is exceeded.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
    },
    'time': {
        '_label': 'Date & Time',
        '_description': 'Clock, timezone, and GPS time synchronization',
        'TimeSet':         {'_section': 'Tab1', 'label': 'Time Setting Mode', 'description': 'How the dashcam clock is set. GPS sync is recommended.', 'type': 'select', 'options': {0: 'Manual', 1: 'GPS Sync'}},
        'GpsSync':         {'_section': 'Tab1', 'label': 'GPS Time Sync', 'description': 'Automatically synchronize clock with GPS satellite time.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'TimeZone':        {'_section': 'Tab1', 'label': 'Time Zone', 'description': 'UTC offset in HHMM format. Examples: -0500 (EST), -0800 (PST), +0000 (UTC), +0900 (KST).', 'type': 'text', 'placeholder': '-0500'},
        'Daylight':        {'_section': 'Tab1', 'label': 'Daylight Saving Time', 'description': 'Enable DST adjustment (+1 hour).', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'SetTime':         {'_section': 'Tab1', 'label': 'Manual Time', 'description': 'Set time manually (only when Time Setting Mode is Manual).', 'type': 'text'},
    },
    'led': {
        '_label': 'LED Indicators',
        '_description': 'Status lights on the camera body',
        'RECLED':          {'_section': 'Tab3', 'label': 'Recording LED', 'description': 'Front-facing recording indicator. Shows the camera is actively recording.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'NORMALLED':       {'_section': 'Tab3', 'label': 'Normal Mode LED', 'description': 'LED during normal (driving) recording.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'RearLED':         {'_section': 'Tab3', 'label': 'Rear Camera LED', 'description': 'Status LED on the rear camera module.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'WifiLED':         {'_section': 'Tab3', 'label': 'WiFi LED', 'description': 'WiFi status indicator light.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
    },
    'voice': {
        '_label': 'Voice Announcements',
        '_description': 'Audio announcements from the camera speaker',
        'VOLUME':          {'_section': 'Tab3', 'label': 'Speaker Volume', 'description': 'Volume for all voice announcements and alerts.', 'type': 'select', 'options': {0: 'Mute', 1: 'Level 1 (Lowest)', 2: 'Level 2', 3: 'Level 3', 4: 'Level 4', 5: 'Level 5 (Loudest)'}},
        'STARTVOICE':      {'_section': 'Tab3', 'label': 'Startup', 'description': 'Announce when the camera powers on.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'ENDVOICE':        {'_section': 'Tab3', 'label': 'Shutdown', 'description': 'Announce when the camera powers off.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'NORMALSTARTVOICE': {'_section': 'Tab3', 'label': 'Recording Start', 'description': 'Announce when normal recording begins.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'EVENTSTARTVOICE': {'_section': 'Tab3', 'label': 'Event Triggered', 'description': 'Announce when an impact/event is detected.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'CHANGERECORDMODEVOICE': {'_section': 'Tab3', 'label': 'Mode Change', 'description': 'Announce when switching between normal and parking.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'CHANGECONFIGVOICE': {'_section': 'Tab3', 'label': 'Config Changed', 'description': 'Confirm when settings are changed.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'ACCELERATIONVOICE': {'_section': 'Tab3', 'label': 'Rapid Acceleration', 'description': 'Alert on aggressive acceleration.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'HARSHBRAKINGVOICE': {'_section': 'Tab3', 'label': 'Harsh Braking', 'description': 'Alert on hard braking.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'SHARPTURNVOICE':  {'_section': 'Tab3', 'label': 'Sharp Turn', 'description': 'Alert on aggressive steering.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'CLOUDVOICE':      {'_section': 'Tab3', 'label': 'Cloud Events', 'description': 'Announce cloud connectivity events.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
    },
    'system': {
        '_label': 'System',
        '_description': 'Proximity sensor, scheduled reboot, and maintenance',
        'PSENSOR':         {'_section': 'Tab3', 'label': 'Proximity Sensor', 'description': 'Touch sensor on the camera body. Tapping toggles audio or triggers a manual event.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'ScheduledReboot': {'_section': 'Tab3', 'label': 'Scheduled Daily Reboot', 'description': 'Auto-restart the camera daily to clear memory. Recommended for 24/7 parking mode.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'ScheduledRebootTime': {'_section': 'Tab3', 'label': 'Reboot Time (Hour)', 'description': 'Hour of the day (0\u201323) for the reboot. Pick a time when the vehicle is not in use.', 'type': 'range', 'min': 0, 'max': 23},
    },
    'wifi': {
        '_label': 'WiFi Hotspot',
        '_description': 'Camera\u2019s own WiFi network for direct phone/computer connection',
        'ap_ssid':         {'_section': 'Wifi', 'label': 'Network Name (SSID)', 'description': 'The camera broadcasts this WiFi name. Connect your phone to this to access the camera.', 'type': 'text'},
        'ap_pw':           {'_section': 'Wifi', 'label': 'Password (encrypted)', 'description': 'Encrypted WiFi password. Change via the official app, or enter a new plaintext password (camera re-encrypts on boot).', 'type': 'password'},
        'onstart':         {'_section': 'Wifi', 'label': 'WiFi on Startup', 'description': 'Automatically enable WiFi when the camera powers on.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'WifiSleepMode':   {'_section': 'Wifi', 'label': 'Auto Sleep', 'description': 'Disable WiFi after inactivity to save power. Useful for parking mode.', 'type': 'select', 'options': {0: 'Always On', 1: 'Auto Sleep'}},
        'WiFiBand':        {'_section': 'Wifi', 'label': 'Frequency Band', 'description': '5 GHz = faster transfers, shorter range. 2.4 GHz = better range, slower, more congested.', 'type': 'select', 'options': {0: '2.4 GHz', 1: '5 GHz'}},
    },
    'cloud': {
        '_label': 'Cloud & Remote Access',
        '_description': 'Cloud connectivity for remote live view, GPS tracking, and notifications',
        'CloudService':    {'_section': 'Cloud', 'label': 'Cloud Service', 'description': 'Enable cloud for remote live view, GPS tracking, push notifications, and remote downloads. Requires WiFi internet.', 'type': 'select', 'options': {0: 'Off', 1: 'On'}},
        'sta_ssid':        {'_section': 'Cloud', 'label': 'WiFi Network 1 (SSID)', 'description': 'Primary WiFi for internet (home, office, or mobile hotspot).', 'type': 'text', 'placeholder': 'Your WiFi name'},
        'sta_pw':          {'_section': 'Cloud', 'label': 'WiFi Network 1 Password', 'description': 'Password for primary WiFi.', 'type': 'password'},
        'sta2_ssid':       {'_section': 'Cloud', 'label': 'WiFi Network 2 (SSID)', 'description': 'Fallback WiFi if Network 1 is unavailable.', 'type': 'text'},
        'sta2_pw':         {'_section': 'Cloud', 'label': 'WiFi Network 2 Password', 'description': 'Password for Network 2.', 'type': 'password'},
        'sta3_ssid':       {'_section': 'Cloud', 'label': 'WiFi Network 3 (SSID)', 'description': 'Third fallback WiFi network.', 'type': 'text'},
        'sta3_pw':         {'_section': 'Cloud', 'label': 'WiFi Network 3 Password', 'description': 'Password for Network 3.', 'type': 'password'},
        'CloudSettingVersion': {'_section': 'Cloud', 'label': 'Last Cloud Sync', 'description': 'Timestamp of last cloud settings sync. Updated automatically.', 'type': 'readonly'},
    },
}


def load_settings():
    try:
        with open(SETTINGS_FILE, 'r') as f:
            saved = json.load(f)
        merged = dict(DEFAULT_SETTINGS)
        merged.update(saved)
        return merged
    except (FileNotFoundError, json.JSONDecodeError):
        return dict(DEFAULT_SETTINGS)


def save_settings(settings):
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    with open(SETTINGS_FILE, 'w') as f:
        json.dump(settings, f, indent=2)


def parse_dashcam_filename(filename):
    match = FILE_PATTERN.match(filename)
    if not match:
        return None
    date_str, time_str, rec_type = match.groups()
    rec_type = rec_type.upper()
    try:
        dt = datetime.strptime(f'{date_str}_{time_str}', '%Y%m%d_%H%M%S')
    except ValueError:
        return None
    return {
        'date': dt.strftime('%Y-%m-%d'),
        'time': dt.strftime('%H:%M:%S'),
        'datetime': dt.isoformat(),
        'timestamp': dt.timestamp(),
        'type': rec_type,
        'type_label': TYPE_LABELS.get(rec_type, rec_type),
        'category': TYPE_CATEGORIES.get(rec_type[0], 'unknown'),
        'camera': 'front' if rec_type.endswith('F') else 'rear',
    }


def extract_gps_from_mp4(filepath):
    """Extract embedded GPS data from a BlackVue MP4 file's gps atom."""
    try:
        with open(filepath, 'rb') as f:
            data = f.read()
        # Find the 'gps ' atom - size is in the 4 bytes before the tag
        idx = data.find(b'gps ')
        if idx < 0 or idx < 4:
            return []
        atom_size = struct.unpack('>I', data[idx - 4:idx])[0]
        if atom_size < 8 or atom_size > 10 * 1024 * 1024:
            # Fallback: read a reasonable chunk
            atom_size = min(512 * 1024, len(data) - idx)
        gps_block = data[idx:idx + atom_size].decode('ascii', errors='ignore')
        return _parse_nmea_text(gps_block)
    except Exception:
        return []


def has_embedded_gps(filepath):
    """Quick check if an MP4 has embedded GPS data with valid fixes."""
    try:
        with open(filepath, 'rb') as f:
            # Just read first ~500KB where the gps atom usually lives
            data = f.read(512 * 1024)
        if b'gps ' not in data:
            return False
        # Check for at least one valid fix (status A)
        return b'GPRMC,' in data and b',A,' in data
    except Exception:
        return False


def _parse_nmea_text(text):
    """Parse NMEA sentences from text with optional [timestamp] prefixes."""
    points = []
    timestamp_pattern = re.compile(r'\[(\d+)\]')
    # Match the full GPRMC/GPGGA sentence after the $
    rmc_pattern = re.compile(r'\$GPRMC,([^\*\n]+)')
    gga_pattern = re.compile(r'\$GPGGA,([^\*\n]+)')

    for line in text.split('\n'):
        line = line.strip()
        if '$GPRMC' in line:
            ts_match = timestamp_pattern.search(line)
            ts_ms = int(ts_match.group(1)) if ts_match else None

            rmc_match = rmc_pattern.search(line)
            if not rmc_match:
                continue
            parts = rmc_match.group(1).split(',')
            # parts[0]=time, parts[1]=status, parts[2]=lat, parts[3]=NS,
            # parts[4]=lon, parts[5]=EW, parts[6]=speed, parts[7]=heading
            if len(parts) >= 7 and parts[1] == 'A':
                try:
                    lat = _nmea_to_decimal(parts[2], parts[3])
                    lon = _nmea_to_decimal(parts[4], parts[5])
                    if lat and lon:
                        speed_knots = float(parts[6]) if parts[6] else 0
                        speed_kmh = speed_knots * 1.852
                        heading = None
                        if len(parts) >= 8 and parts[7]:
                            try:
                                heading = float(parts[7])
                            except ValueError:
                                pass
                        point = {
                            'lat': lat, 'lng': lon,
                            'speed': round(speed_kmh, 1),
                        }
                        if ts_ms is not None:
                            point['time_ms'] = ts_ms
                        if heading is not None:
                            point['heading'] = round(heading, 1)
                        points.append(point)
                except (ValueError, IndexError):
                    continue
        elif '$GPGGA' in line:
            ts_match = timestamp_pattern.search(line)
            ts_ms = int(ts_match.group(1)) if ts_match else None

            gga_match = gga_pattern.search(line)
            if not gga_match:
                continue
            parts = gga_match.group(1).split(',')
            # parts[0]=time, parts[1]=lat, parts[2]=NS, parts[3]=lon, parts[4]=EW,
            # parts[5]=quality, parts[6]=numsat, parts[7]=hdop, parts[8]=alt
            if len(parts) >= 9 and parts[5] in ('1', '2'):
                try:
                    alt = float(parts[8]) if parts[8] else None
                    if alt is not None and points:
                        if ts_ms is not None:
                            for p in reversed(points):
                                if p.get('time_ms') == ts_ms:
                                    p['alt'] = round(alt, 1)
                                    break
                            else:
                                points[-1]['alt'] = round(alt, 1)
                        else:
                            points[-1]['alt'] = round(alt, 1)
                except (ValueError, IndexError):
                    pass

    if points and 'time_ms' not in points[0]:
        for p in points:
            p['time_ms'] = None
    return points


def parse_nmea_gps(filepath):
    """Parse GPS data from a standalone .gps file."""
    try:
        with open(filepath, 'rb') as f:
            content = f.read()
        text = content.decode('ascii', errors='ignore')
        return _parse_nmea_text(text)
    except Exception:
        return []


def parse_binary_gps(filepath):
    points = []
    try:
        with open(filepath, 'rb') as f:
            content = f.read()
        offset = 0
        while offset < len(content) - 16:
            try:
                lat = struct.unpack_from('<d', content, offset)[0]
                lon = struct.unpack_from('<d', content, offset + 8)[0]
                if -90 <= lat <= 90 and -180 <= lon <= 180 and (lat != 0 or lon != 0):
                    speed = 0
                    if offset + 20 <= len(content):
                        try:
                            speed = struct.unpack_from('<f', content, offset + 16)[0]
                            if speed < 0 or speed > 500:
                                speed = 0
                        except struct.error:
                            pass
                    points.append({
                        'lat': round(lat, 6), 'lng': round(lon, 6),
                        'speed': round(speed, 1), 'time_ms': None,
                    })
                    offset += 20
                else:
                    offset += 1
            except struct.error:
                offset += 1
    except Exception:
        pass
    return points


def _nmea_to_decimal(coord, direction):
    if not coord:
        return None
    try:
        if '.' in coord:
            dot_pos = coord.index('.')
            degrees = int(coord[:dot_pos - 2])
            minutes = float(coord[dot_pos - 2:])
        else:
            return None
        decimal = degrees + minutes / 60.0
        if direction in ('S', 'W'):
            decimal = -decimal
        return round(decimal, 6)
    except (ValueError, IndexError):
        return None


def parse_3gf_gsensor(filepath):
    """Parse G-sensor data from a standalone .3gf file."""
    data = []
    try:
        with open(filepath, 'rb') as f:
            content = f.read()
        offset = 0
        while offset < len(content) - 12:
            try:
                x = struct.unpack_from('<f', content, offset)[0]
                y = struct.unpack_from('<f', content, offset + 4)[0]
                z = struct.unpack_from('<f', content, offset + 8)[0]
                if all(-16 <= v <= 16 for v in (x, y, z)):
                    data.append({'x': round(x, 3), 'y': round(y, 3), 'z': round(z, 3)})
                    offset += 12
                else:
                    offset += 1
            except struct.error:
                offset += 1
    except Exception:
        pass
    return data


def extract_gsensor_from_mp4(filepath):
    """Extract G-sensor data from a BlackVue MP4 file's 3gf atom.

    Format: 10 bytes per record (big-endian)
      - 4 bytes uint32: timestamp in milliseconds
      - 2 bytes int16: X-axis (forward/backward)
      - 2 bytes int16: Y-axis (left/right)
      - 2 bytes int16: Z-axis (up/down)
    Values are raw units where ~100 = 1G.
    """
    data = []
    try:
        with open(filepath, 'rb') as f:
            raw = f.read()

        idx = raw.find(b'3gf ')
        if idx < 0 or idx < 4:
            return []

        atom_size = struct.unpack('>I', raw[idx - 4:idx])[0]
        if atom_size < 18 or atom_size > 10 * 1024 * 1024:
            return []

        content = raw[idx + 4:idx - 4 + atom_size]
        record_size = 10
        num_records = len(content) // record_size
        scale = 100.0  # ~100 raw units = 1G

        for i in range(num_records):
            off = i * record_size
            ts = struct.unpack_from('>I', content, off)[0]
            x = struct.unpack_from('>h', content, off + 4)[0]
            y = struct.unpack_from('>h', content, off + 6)[0]
            z = struct.unpack_from('>h', content, off + 8)[0]

            # Skip zero-padded trailing records
            if ts == 0 and x == 0 and y == 0 and z == 0 and i > 0:
                continue

            data.append({
                'time_ms': ts,
                'x': round(x / scale, 3),
                'y': round(y / scale, 3),
                'z': round(z / scale, 3),
            })
    except Exception:
        pass
    return data


def has_embedded_gsensor(filepath):
    """Quick check if an MP4 has embedded G-sensor data."""
    try:
        with open(filepath, 'rb') as f:
            data = f.read(512 * 1024)
        return b'3gf ' in data
    except Exception:
        return False


def scan_directory(root_path):
    files = []
    root = Path(root_path)
    if not root.exists():
        return files

    search_dirs = [root]
    for subdir in ['Record', 'record', 'DCIM', 'Movie', 'Normal', 'Event', 'Parking']:
        candidate = root / subdir
        if candidate.exists():
            search_dirs.append(candidate)

    seen = set()
    for search_dir in search_dirs:
        try:
            for entry in search_dir.iterdir():
                if entry.is_file() and entry.suffix.lower() == '.mp4':
                    if entry.name in seen:
                        continue
                    seen.add(entry.name)
                    meta = parse_dashcam_filename(entry.name)
                    if meta is None:
                        stat = entry.stat()
                        meta = {
                            'date': datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d'),
                            'time': datetime.fromtimestamp(stat.st_mtime).strftime('%H:%M:%S'),
                            'datetime': datetime.fromtimestamp(stat.st_mtime).isoformat(),
                            'timestamp': stat.st_mtime,
                            'type': '??', 'type_label': 'Unknown',
                            'category': 'unknown', 'camera': 'unknown',
                        }
                    meta['filename'] = entry.name
                    meta['path'] = str(entry.relative_to(root))
                    fstat = entry.stat()
                    meta['size'] = fstat.st_size
                    meta['size_human'] = _human_size(fstat.st_size)
                    gps_file = entry.with_suffix('.gps')
                    meta['has_gps'] = gps_file.exists() or has_embedded_gps(entry)
                    g_file = entry.with_suffix('.3gf')
                    meta['has_gsensor'] = g_file.exists() or has_embedded_gsensor(entry)
                    # Check if a paired rear/front file exists
                    if meta['camera'] == 'front':
                        pair = entry.parent / entry.name.replace('F.mp4', 'R.mp4')
                    else:
                        pair = entry.parent / entry.name.replace('R.mp4', 'F.mp4')
                    meta['has_pair'] = pair.exists()
                    files.append(meta)
        except PermissionError:
            continue

    files.sort(key=lambda x: x['timestamp'])
    return files


def _human_size(nbytes):
    for unit in ('B', 'KB', 'MB', 'GB'):
        if nbytes < 1024:
            return f'{nbytes:.1f} {unit}'
        nbytes /= 1024
    return f'{nbytes:.1f} TB'


# --- Dashcam config parsing ---

def read_dashcam_config():
    """Read config.ini from the dashcam SD card."""
    config_path = os.path.join(DASHCAM_ROOT, 'Config', 'config.ini')
    if not os.path.isfile(config_path):
        return None

    sections = {}
    current_section = None

    try:
        with open(config_path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('-----'):
                    continue
                if line.startswith('[') and line.endswith(']'):
                    current_section = line[1:-1]
                    sections[current_section] = {}
                elif '=' in line and current_section:
                    key, _, value = line.partition('=')
                    sections[current_section][key.strip()] = value.strip()
    except Exception:
        return None

    return sections


def write_dashcam_config(sections):
    """Write config.ini back to the dashcam SD card. Creates a backup first."""
    config_path = os.path.join(DASHCAM_ROOT, 'Config', 'config.ini')
    if not os.path.isfile(config_path):
        return False

    # Create backup
    backup_path = config_path + '.bak'
    try:
        shutil.copy2(config_path, backup_path)
    except Exception:
        pass

    try:
        lines = []
        for section_name in ['Tab1', 'Tab2', 'Tab3', 'Wifi', 'Cloud']:
            if section_name not in sections:
                continue
            lines.append(f'[{section_name}]')
            for key, value in sections[section_name].items():
                lines.append(f'{key}={value}')
            lines.append('')

        lines.append('')
        lines.append('-----*****-----')

        with open(config_path, 'w', encoding='utf-8', newline='\r\n') as f:
            f.write('\n'.join(lines))
        return True
    except Exception:
        return False


def read_version_info():
    """Read version.bin from the dashcam SD card."""
    version_path = os.path.join(DASHCAM_ROOT, 'Config', 'version.bin')
    if not os.path.isfile(version_path):
        return None

    info = {}
    current_section = None
    try:
        with open(version_path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if line.startswith('[') and line.endswith(']'):
                    current_section = line[1:-1]
                elif '=' in line:
                    key, _, value = line.partition('=')
                    key = key.strip()
                    value = value.strip()
                    # Prefix keys with section to avoid collisions
                    if current_section == 'firmware':
                        if key == 'version':
                            info['firmware_version'] = value
                        else:
                            info[key] = value
                    elif current_section == 'config':
                        if key == 'version':
                            info['config_version'] = value
                        else:
                            info[key] = value
                    else:
                        info[key] = value
    except Exception:
        return None

    return info


# --- Routes ---

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/config')
def get_config():
    global DASHCAM_ROOT
    # Restore saved root from settings if current is the default
    saved = load_settings()
    if saved.get('dashcam_root') and os.path.isdir(saved['dashcam_root']):
        DASHCAM_ROOT = saved['dashcam_root']
    return jsonify({
        'root': DASHCAM_ROOT,
        'exists': os.path.isdir(DASHCAM_ROOT),
    })


@app.route('/api/folder-history')
def folder_history():
    s = load_settings()
    return jsonify({'history': s.get('folder_history', [])})


@app.route('/api/settings', methods=['GET'])
def get_settings():
    return jsonify(load_settings())


@app.route('/api/settings', methods=['POST'])
def update_settings():
    data = request.get_json()
    if data.get('_reset'):
        save_settings(dict(DEFAULT_SETTINGS))
        return jsonify(dict(DEFAULT_SETTINGS))
    current = load_settings()
    for key in DEFAULT_SETTINGS:
        if key in data:
            expected_type = type(DEFAULT_SETTINGS[key])
            val = data[key]
            if expected_type == bool:
                val = bool(val)
            elif expected_type == int:
                val = int(val)
            elif expected_type == float:
                val = float(val)
            elif expected_type == str:
                val = str(val)
            current[key] = val
    save_settings(current)
    return jsonify(current)


@app.route('/api/set-root', methods=['POST'])
def set_root():
    global DASHCAM_ROOT
    data = request.get_json()
    path = data.get('path', '').strip()
    if not path or not os.path.isdir(path):
        return jsonify({'error': 'Invalid directory path'}), 400
    DASHCAM_ROOT = path
    # Persist the folder path, filters, and add to history
    current = load_settings()
    current['dashcam_root'] = path
    history = current.get('folder_history', [])
    if path in history:
        history.remove(path)
    history.insert(0, path)
    current['folder_history'] = history[:20]  # Keep last 20
    save_settings(current)
    return jsonify({'root': DASHCAM_ROOT, 'exists': True})


@app.route('/api/files')
def list_files():
    category = request.args.get('category', 'all')
    camera = request.args.get('camera', 'all')
    date = request.args.get('date', '')

    all_files = scan_directory(DASHCAM_ROOT)
    dates = sorted(set(f['date'] for f in all_files), reverse=True)

    files = all_files
    if category != 'all':
        files = [f for f in files if f['category'] == category]
    if camera == 'dual':
        basenames = set()
        for f in files:
            base = f['filename'][:-6]
            basenames.add(base)
        dual_bases = set()
        for base in basenames:
            has_front = any(f['filename'].startswith(base) and f['camera'] == 'front' for f in files)
            has_rear = any(f['filename'].startswith(base) and f['camera'] == 'rear' for f in files)
            if has_front and has_rear:
                dual_bases.add(base)
        files = [f for f in files if f['filename'][:-6] in dual_bases and f['camera'] == 'front']
    elif camera != 'all':
        files = [f for f in files if f['camera'] == camera]
    if date:
        files = [f for f in files if f['date'] == date]

    return jsonify({'files': files, 'dates': dates})


@app.route('/api/video/<path:filepath>')
def serve_video(filepath):
    full_path = os.path.join(DASHCAM_ROOT, filepath)
    full_path = os.path.realpath(full_path)
    if not full_path.startswith(os.path.realpath(DASHCAM_ROOT)):
        abort(403)
    if not os.path.isfile(full_path):
        abort(404)

    file_size = os.path.getsize(full_path)
    mimetype = mimetypes.guess_type(full_path)[0] or 'video/mp4'

    range_header = request.headers.get('Range')
    if range_header:
        match = re.match(r'bytes=(\d+)-(\d*)', range_header)
        if match:
            start = int(match.group(1))
            end = int(match.group(2)) if match.group(2) else file_size - 1
            end = min(end, file_size - 1)
            length = end - start + 1

            def generate():
                with open(full_path, 'rb') as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk_size = min(8192, remaining)
                        chunk = f.read(chunk_size)
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        yield chunk

            response = Response(generate(), status=206, mimetype=mimetype, direct_passthrough=True)
            response.headers['Content-Range'] = f'bytes {start}-{end}/{file_size}'
            response.headers['Content-Length'] = length
            response.headers['Accept-Ranges'] = 'bytes'
            return response

    return send_file(full_path, mimetype=mimetype)


@app.route('/api/gps/<path:filepath>')
def get_gps_data(filepath):
    video_path = os.path.join(DASHCAM_ROOT, filepath)
    video_path = os.path.realpath(video_path)
    if not video_path.startswith(os.path.realpath(DASHCAM_ROOT)):
        abort(403)
    # Try separate .gps file first
    gps_path = os.path.splitext(video_path)[0] + '.gps'
    points = []
    if os.path.isfile(gps_path):
        points = parse_nmea_gps(gps_path)
        if not points:
            points = parse_binary_gps(gps_path)

    # Fall back to extracting from the MP4 itself (BlackVue embeds GPS in mp4)
    if not points and os.path.isfile(video_path):
        points = extract_gps_from_mp4(video_path)

    return jsonify({'points': points, 'available': bool(points)})


@app.route('/api/gsensor/<path:filepath>')
def get_gsensor_data(filepath):
    video_path = os.path.join(DASHCAM_ROOT, filepath)
    video_path = os.path.realpath(video_path)
    if not video_path.startswith(os.path.realpath(DASHCAM_ROOT)):
        abort(403)
    # Try separate .3gf file first
    g_path = os.path.splitext(video_path)[0] + '.3gf'
    data = []
    if os.path.isfile(g_path):
        data = parse_3gf_gsensor(g_path)

    # Fall back to extracting from the MP4 itself
    if not data and os.path.isfile(video_path):
        data = extract_gsensor_from_mp4(video_path)

    return jsonify({'data': data, 'available': bool(data)})


@app.route('/api/dates')
def get_dates():
    files = scan_directory(DASHCAM_ROOT)
    dates = sorted(set(f['date'] for f in files), reverse=True)
    return jsonify({'dates': dates})


@app.route('/api/stats')
def get_stats():
    files = scan_directory(DASHCAM_ROOT)
    total_size = sum(f['size'] for f in files)
    categories = {}
    for f in files:
        cat = f['category']
        if cat not in categories:
            categories[cat] = {'count': 0, 'size': 0}
        categories[cat]['count'] += 1
        categories[cat]['size'] += f['size']
    return jsonify({
        'total_files': len(files),
        'total_size': _human_size(total_size),
        'categories': categories,
        'date_range': {
            'start': files[0]['date'] if files else None,
            'end': files[-1]['date'] if files else None,
        }
    })


@app.route('/api/trips')
def get_trips():
    """Detect and return trips grouped by time gaps."""
    files = scan_directory(DASHCAM_ROOT)
    # Only front camera for trip grouping (avoid duplicate counting)
    fronts = [f for f in files if f['camera'] == 'front']
    fronts.sort(key=lambda x: x['timestamp'])

    trips = []
    current_trip = []
    gap_threshold = 300  # 5 minutes gap = new trip

    for f in fronts:
        if current_trip:
            last_ts = current_trip[-1]['timestamp']
            # Each clip is ~60s, so add that to the gap check
            if f['timestamp'] - last_ts > gap_threshold:
                trips.append(_build_trip(current_trip, len(trips)))
                current_trip = []
        current_trip.append(f)

    if current_trip:
        trips.append(_build_trip(current_trip, len(trips)))

    return jsonify({'trips': trips})


def _build_trip(clips, idx):
    """Build a trip summary from a list of sequential clips."""
    categories = {}
    total_size = 0
    has_gps = False
    for c in clips:
        cat = c['category']
        categories[cat] = categories.get(cat, 0) + 1
        total_size += c['size']
        if c.get('has_gps'):
            has_gps = True

    duration_secs = clips[-1]['timestamp'] - clips[0]['timestamp'] + 60  # +60 for last clip
    return {
        'id': idx,
        'date': clips[0]['date'],
        'start_time': clips[0]['time'],
        'end_time': clips[-1]['time'],
        'clip_count': len(clips),
        'duration': _format_duration(duration_secs),
        'duration_secs': duration_secs,
        'size': _human_size(total_size),
        'categories': categories,
        'has_gps': has_gps,
        'first_file': clips[0]['filename'],
        'first_path': clips[0]['path'],
        'last_file': clips[-1]['filename'],
        'file_paths': [c['path'] for c in clips],
    }


def _format_duration(secs):
    """Format seconds into human readable duration."""
    if secs < 60:
        return f'{int(secs)}s'
    elif secs < 3600:
        return f'{int(secs // 60)}m {int(secs % 60)}s'
    else:
        h = int(secs // 3600)
        m = int((secs % 3600) // 60)
        return f'{h}h {m}m'


TRACKS_CACHE_FILE = os.path.join(os.path.expanduser('~'), '.cache', 'dashview', 'tracks.json')
TRACKS_PROGRESS_FILE = os.path.join(os.path.expanduser('~'), '.cache', 'dashview', 'tracks_progress.json')

import threading
_tracks_build_lock = threading.Lock()
_tracks_building = False


@app.route('/api/all-tracks')
def all_tracks():
    """Get cached GPS tracks and build status."""
    cache = _load_tracks_cache()
    progress = _load_tracks_progress()
    return jsonify({
        'tracks': cache.get('tracks', []),
        'count': len(cache.get('tracks', [])),
        'ready': cache.get('ready', False),
        'building': _tracks_building,
        'progress': progress,
    })


@app.route('/api/all-tracks/build', methods=['POST'])
def start_tracks_build():
    """Start background GPS tracks cache build."""
    global _tracks_building
    if _tracks_building:
        return jsonify({'status': 'already_building'})

    thread = threading.Thread(target=_build_tracks_background, daemon=True)
    thread.start()
    return jsonify({'status': 'started'})


def _build_tracks_background():
    """Build GPS tracks cache in background thread."""
    global _tracks_building
    with _tracks_build_lock:
        _tracks_building = True
        try:
            files = scan_directory(DASHCAM_ROOT)
            fronts = [f for f in files if f['camera'] == 'front' and f.get('has_gps')]
            fronts.sort(key=lambda x: x['timestamp'])
            total = len(fronts)

            _save_tracks_progress(0, total, 'Starting...')

            tracks = []
            for i, f in enumerate(fronts):
                video_path = os.path.join(DASHCAM_ROOT, f['path'])
                video_path = os.path.realpath(video_path)

                gps_path = os.path.splitext(video_path)[0] + '.gps'
                points = []
                if os.path.isfile(gps_path):
                    points = parse_nmea_gps(gps_path)
                if not points and os.path.isfile(video_path):
                    points = extract_gps_from_mp4(video_path)

                if points:
                    step = max(1, len(points) // 15)
                    sampled = points[::step]
                    tracks.append({
                        'file': f['filename'],
                        'date': f['date'],
                        'time': f['time'],
                        'category': f['category'],
                        'points': [{'lat': p['lat'], 'lng': p['lng']} for p in sampled],
                    })

                if (i + 1) % 5 == 0 or i == total - 1:
                    _save_tracks_progress(i + 1, total, f['filename'])

            # Save final cache
            os.makedirs(os.path.dirname(TRACKS_CACHE_FILE), exist_ok=True)
            cache = {'tracks': tracks, 'ready': True, 'root': DASHCAM_ROOT, 'file_count': total}
            with open(TRACKS_CACHE_FILE, 'w') as cf:
                json.dump(cache, cf)

            _save_tracks_progress(total, total, 'Done')
        finally:
            _tracks_building = False


def _save_tracks_progress(current, total, current_file):
    os.makedirs(os.path.dirname(TRACKS_PROGRESS_FILE), exist_ok=True)
    with open(TRACKS_PROGRESS_FILE, 'w') as f:
        json.dump({
            'current': current,
            'total': total,
            'pct': round(current / total * 100) if total else 0,
            'file': current_file,
        }, f)


def _load_tracks_progress():
    try:
        with open(TRACKS_PROGRESS_FILE, 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _load_tracks_cache():
    try:
        with open(TRACKS_CACHE_FILE, 'r') as f:
            cache = json.load(f)
        if cache.get('root') == DASHCAM_ROOT:
            return cache
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return {'tracks': [], 'ready': False}


@app.route('/api/sd-health')
def sd_health():
    """Get SD card storage health breakdown."""
    files = scan_directory(DASHCAM_ROOT)
    if not files:
        return jsonify({'available': False})

    # Category breakdown
    by_category = {}
    by_camera = {'front': 0, 'rear': 0}
    total_size = 0
    total_duration = 0
    dates = set()

    for f in files:
        cat = f['category']
        if cat not in by_category:
            by_category[cat] = {'count': 0, 'size': 0}
        by_category[cat]['count'] += 1
        by_category[cat]['size'] += f['size']
        by_camera[f.get('camera', 'front')] = by_camera.get(f.get('camera', 'front'), 0) + f['size']
        total_size += f['size']
        total_duration += 60  # assume ~60s per clip
        dates.add(f['date'])

    # Try to get total SD card size
    sd_total = None
    sd_free = None
    try:
        stat = os.statvfs(DASHCAM_ROOT)
        sd_total = stat.f_blocks * stat.f_frsize
        sd_free = stat.f_bavail * stat.f_frsize
    except Exception:
        pass

    # Format category sizes
    for cat in by_category:
        by_category[cat]['size_human'] = _human_size(by_category[cat]['size'])
        by_category[cat]['pct'] = round(by_category[cat]['size'] / total_size * 100, 1) if total_size else 0

    return jsonify({
        'available': True,
        'total_files': len(files),
        'total_size': _human_size(total_size),
        'total_size_bytes': total_size,
        'total_duration': _format_duration(total_duration),
        'date_range': sorted(dates),
        'recording_days': len(dates),
        'by_category': by_category,
        'by_camera': {k: _human_size(v) for k, v in by_camera.items()},
        'sd_total': _human_size(sd_total) if sd_total else None,
        'sd_free': _human_size(sd_free) if sd_free else None,
        'sd_total_bytes': sd_total,
        'sd_free_bytes': sd_free,
        'sd_used_pct': round((1 - sd_free / sd_total) * 100, 1) if sd_total and sd_free else None,
    })


@app.route('/api/dashcam/info')
def dashcam_info():
    """Get dashcam version/model info and whether config exists."""
    version = read_version_info()
    has_config = os.path.isfile(os.path.join(DASHCAM_ROOT, 'Config', 'config.ini'))
    return jsonify({
        'version': version,
        'has_config': has_config,
    })


@app.route('/api/dashcam/config')
def dashcam_config_get():
    """Read the dashcam config.ini and return with schema."""
    sections = read_dashcam_config()
    if sections is None:
        return jsonify({'error': 'Config file not found', 'available': False}), 404
    return jsonify({
        'available': True,
        'config': sections,
        'schema': CONFIG_SCHEMA,
    })


@app.route('/api/dashcam/config', methods=['POST'])
def dashcam_config_save():
    """Save updated config.ini to the dashcam SD card."""
    data = request.get_json()
    sections = data.get('config')
    if not sections:
        return jsonify({'error': 'No config data provided'}), 400

    if write_dashcam_config(sections):
        return jsonify({'success': True, 'message': 'Config saved. Remove the SD card safely and insert it into the dashcam to apply.'})
    else:
        return jsonify({'error': 'Failed to write config file'}), 500


@app.route('/api/dashcam/config/backup')
def dashcam_config_backup():
    """Download a backup of the current config.ini."""
    config_path = os.path.join(DASHCAM_ROOT, 'Config', 'config.ini')
    if not os.path.isfile(config_path):
        abort(404)
    return send_file(config_path, as_attachment=True, download_name='config.ini')


THUMB_CACHE_DIR = os.path.join(os.path.expanduser('~'), '.cache', 'dashview', 'thumbs')
PREVIEW_CACHE_DIR = os.path.join(os.path.expanduser('~'), '.cache', 'dashview', 'previews')


@app.route('/api/thumb/<path:filepath>')
def get_thumbnail(filepath):
    """Generate and serve a thumbnail for a video file."""
    full_path = os.path.join(DASHCAM_ROOT, filepath)
    full_path = os.path.realpath(full_path)
    if not full_path.startswith(os.path.realpath(DASHCAM_ROOT)):
        abort(403)
    if not os.path.isfile(full_path):
        abort(404)

    # Cache key based on filename and modification time
    stat = os.stat(full_path)
    cache_key = f"{os.path.basename(full_path)}_{int(stat.st_mtime)}"
    os.makedirs(THUMB_CACHE_DIR, exist_ok=True)
    thumb_path = os.path.join(THUMB_CACHE_DIR, cache_key + '.jpg')

    if not os.path.isfile(thumb_path):
        # Generate thumbnail: grab frame at 3 seconds, scale to 160px wide
        try:
            subprocess.run([
                'ffmpeg', '-y', '-ss', '3', '-i', full_path,
                '-vframes', '1', '-vf', 'scale=160:-1',
                '-q:v', '8', thumb_path
            ], capture_output=True, timeout=15)
        except Exception:
            abort(500)

    if not os.path.isfile(thumb_path):
        abort(500)

    response = send_file(thumb_path, mimetype='image/jpeg')
    response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    return response


@app.route('/api/preview-strip/<path:filepath>')
def get_preview_strip(filepath):
    """Generate a preview thumbnail strip (sprite sheet) for seek bar hover."""
    full_path = os.path.join(DASHCAM_ROOT, filepath)
    full_path = os.path.realpath(full_path)
    if not full_path.startswith(os.path.realpath(DASHCAM_ROOT)):
        abort(403)
    if not os.path.isfile(full_path):
        abort(404)

    num_frames = 30  # number of preview thumbnails
    frame_w = 160
    frame_h = 90

    stat = os.stat(full_path)
    cache_key = f"{os.path.basename(full_path)}_{int(stat.st_mtime)}_{num_frames}"
    os.makedirs(PREVIEW_CACHE_DIR, exist_ok=True)
    strip_path = os.path.join(PREVIEW_CACHE_DIR, cache_key + '.jpg')

    if not os.path.isfile(strip_path):
        try:
            # Generate N evenly-spaced frames and tile them horizontally
            subprocess.run([
                'ffmpeg', '-y', '-i', full_path,
                '-vf', f'fps={num_frames}/60,scale={frame_w}:{frame_h},tile={num_frames}x1',
                '-frames:v', '1',
                '-q:v', '6', strip_path
            ], capture_output=True, timeout=30)
        except Exception:
            abort(500)

    if not os.path.isfile(strip_path):
        abort(500)

    response = send_file(strip_path, mimetype='image/jpeg')
    response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    return response


@app.route('/api/batch-export', methods=['POST'])
def batch_export():
    """Export multiple files as a zip archive."""
    data = request.get_json()
    file_paths = data.get('files', [])
    remove_audio = data.get('no_audio', False)

    if not file_paths:
        return jsonify({'error': 'No files selected'}), 400

    if len(file_paths) > 200:
        return jsonify({'error': 'Maximum 200 files per batch'}), 400

    # Validate all files
    full_paths = []
    for fp in file_paths:
        full = os.path.realpath(os.path.join(DASHCAM_ROOT, fp))
        if not full.startswith(os.path.realpath(DASHCAM_ROOT)):
            abort(403)
        if not os.path.isfile(full):
            return jsonify({'error': f'File not found: {fp}'}), 404
        full_paths.append((fp, full))

    export_dir = tempfile.mkdtemp(prefix='dashview_batch_')

    if remove_audio:
        # Need to strip audio from each file via ffmpeg, then zip
        processed = []
        for rel_path, full_path in full_paths:
            out_name = os.path.basename(full_path).replace('.mp4', '_noaudio.mp4')
            out_path = os.path.join(export_dir, out_name)
            try:
                subprocess.run([
                    'ffmpeg', '-y', '-i', full_path,
                    '-c:v', 'copy', '-an',
                    '-movflags', '+faststart', out_path
                ], capture_output=True, timeout=60)
                if os.path.isfile(out_path):
                    processed.append((out_name, out_path))
            except Exception:
                processed.append((os.path.basename(full_path), full_path))
    else:
        processed = [(os.path.basename(fp), full) for fp, full in full_paths]

    # Create zip
    first_name = os.path.splitext(os.path.basename(full_paths[0][1]))[0]
    zip_name = f'{first_name}_batch_{len(full_paths)}files.zip'
    zip_path = os.path.join(export_dir, zip_name)

    try:
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_STORED) as zf:
            for name, path in processed:
                zf.write(path, name)
    except Exception as e:
        return jsonify({'error': f'Failed to create zip: {str(e)}'}), 500

    file_size = os.path.getsize(zip_path)
    return jsonify({
        'success': True,
        'download_url': f'/api/export/download/{zip_name}?dir={export_dir}',
        'filename': zip_name,
        'size': _human_size(file_size),
        'file_count': len(processed),
    })


@app.route('/api/merge', methods=['POST'])
def merge_videos():
    """Merge multiple video files into one using ffmpeg concat."""
    data = request.get_json()
    file_paths = data.get('files', [])
    remove_audio = data.get('no_audio', False)

    if not file_paths or len(file_paths) < 2:
        return jsonify({'error': 'Need at least 2 files to merge'}), 400

    if len(file_paths) > 100:
        return jsonify({'error': 'Maximum 100 files per merge'}), 400

    # Validate all files
    full_paths = []
    for fp in file_paths:
        full = os.path.realpath(os.path.join(DASHCAM_ROOT, fp))
        if not full.startswith(os.path.realpath(DASHCAM_ROOT)):
            abort(403)
        if not os.path.isfile(full):
            return jsonify({'error': f'File not found: {fp}'}), 404
        full_paths.append(full)

    export_dir = tempfile.mkdtemp(prefix='dashview_merge_')

    # Create concat file list
    concat_path = os.path.join(export_dir, 'concat.txt')
    with open(concat_path, 'w') as f:
        for p in full_paths:
            # Escape single quotes in paths for ffmpeg concat format
            escaped = p.replace("'", "'\\''")
            f.write(f"file '{escaped}'\n")

    # Build output name from first and last file
    first_name = os.path.splitext(os.path.basename(full_paths[0]))[0]
    last_name = os.path.splitext(os.path.basename(full_paths[-1]))[0]
    output_name = f'{first_name}_to_{last_name}_merged.mp4'
    output_path = os.path.join(export_dir, output_name)

    # Use concat demuxer (stream copy, no re-encoding — fast)
    cmd = [
        'ffmpeg', '-y',
        '-f', 'concat', '-safe', '0',
        '-i', concat_path,
        '-c:v', 'copy',
    ]
    if remove_audio:
        cmd += ['-an']
    else:
        cmd += ['-c:a', 'copy']

    cmd += ['-movflags', '+faststart', output_path]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if result.returncode != 0:
            return jsonify({
                'error': 'Merge failed',
                'details': result.stderr[-500:] if result.stderr else 'Unknown error'
            }), 500

        file_size = os.path.getsize(output_path)
        return jsonify({
            'success': True,
            'download_url': f'/api/export/download/{output_name}?dir={export_dir}',
            'filename': output_name,
            'size': _human_size(file_size),
            'clip_count': len(full_paths),
        })
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Merge timed out (10 min limit)'}), 500
    except FileNotFoundError:
        return jsonify({'error': 'ffmpeg not found'}), 500


@app.route('/api/export', methods=['POST'])
def export_video():
    """Export video with optional PiP and audio removal using ffmpeg."""
    data = request.get_json()
    filepath = data.get('file', '')
    include_pip = data.get('pip', False)
    remove_audio = data.get('no_audio', False)
    pip_position = data.get('pip_position', 'bottom-right')
    pip_scale = data.get('pip_scale', 0.25)
    redact_top = data.get('redact_top', False)
    redact_bottom = data.get('redact_bottom', False)
    redact_size = data.get('redact_size', 4)  # percentage of video height
    trim_start = data.get('trim_start')  # seconds (float) or None
    trim_end = data.get('trim_end')  # seconds (float) or None

    # Validate main file
    full_path = os.path.realpath(os.path.join(DASHCAM_ROOT, filepath))
    if not full_path.startswith(os.path.realpath(DASHCAM_ROOT)):
        abort(403)
    if not os.path.isfile(full_path):
        abort(404)

    # Find rear file if PiP requested
    rear_path = None
    if include_pip:
        base = os.path.basename(full_path)
        rear_name = re.sub(r'F\.mp4$', 'R.mp4', base, flags=re.IGNORECASE)
        rear_candidate = os.path.join(os.path.dirname(full_path), rear_name)
        if os.path.isfile(rear_candidate):
            rear_path = rear_candidate
        else:
            include_pip = False  # No rear file, export without PiP

    # Build ffmpeg command
    export_dir = tempfile.mkdtemp(prefix='dashview_export_')
    base_name = os.path.splitext(os.path.basename(full_path))[0]
    has_trim = trim_start is not None or trim_end is not None
    needs_reencode = include_pip or redact_top or redact_bottom
    suffix = ''
    if has_trim:
        suffix += '_trim'
    if include_pip:
        suffix += '_pip'
    if redact_top or redact_bottom:
        suffix += '_redacted'
    if remove_audio:
        suffix += '_noaudio'
    output_name = f'{base_name}{suffix}.mp4'
    output_path = os.path.join(export_dir, output_name)

    # Detect available ffmpeg capabilities
    can_decode_hevc = False
    best_encoder = 'libopenh264'
    try:
        probe = subprocess.run(
            ['ffmpeg', '-decoders'], capture_output=True, text=True, timeout=10
        )
        for line in probe.stdout.split('\n'):
            stripped = line.strip()
            if stripped.startswith('V') and 'hevc' in stripped.lower():
                can_decode_hevc = True
                break
        enc_probe = subprocess.run(
            ['ffmpeg', '-encoders'], capture_output=True, text=True, timeout=10
        )
        if 'libx264' in enc_probe.stdout:
            best_encoder = 'libx264'
    except Exception:
        pass

    cmd = ['ffmpeg', '-y']

    pip_failed = False
    if include_pip and rear_path:
        if not can_decode_hevc:
            include_pip = False
            needs_reencode = redact_top or redact_bottom
            suffix = suffix.replace('_pip', '_front')
            pip_failed = True

    # Redaction also requires re-encoding (and HEVC decoding)
    if (redact_top or redact_bottom) and not can_decode_hevc:
        redact_top = False
        redact_bottom = False
        needs_reencode = include_pip
        suffix = suffix.replace('_redacted', '')

    needs_reencode = include_pip or redact_top or redact_bottom

    # Calculate trim duration
    trim_duration = None
    if has_trim:
        ts = trim_start if trim_start is not None else 0
        te = trim_end  # may be None (= end of file)
        if te is not None:
            trim_duration = te - ts
        trim_start = ts

    if needs_reencode:
        # Build filter chain
        filters = []

        if include_pip and rear_path:
            # Apply -ss before each -i for both inputs to stay synced
            if has_trim and trim_start:
                cmd += ['-ss', str(trim_start)]
            cmd += ['-i', full_path]
            if has_trim and trim_start:
                cmd += ['-ss', str(trim_start)]
            cmd += ['-i', rear_path]
            if trim_duration is not None:
                cmd += ['-t', str(trim_duration)]
            # Scale rear and overlay onto front
            pip_w = f'iw*{pip_scale}'
            margin = '10'
            pos_map = {
                'bottom-right': f'W-w-{margin}:H-h-{margin}',
                'bottom-left': f'{margin}:H-h-{margin}',
                'top-right': f'W-w-{margin}:{margin}',
                'top-left': f'{margin}:{margin}',
            }
            position = pos_map.get(pip_position, pos_map['bottom-right'])
            filters.append(f'[1:v]scale={pip_w}:-1[pip]')
            filters.append(f'[0:v][pip]overlay={position}[main]')
            last_label = 'main'
        else:
            cmd += ['-i', full_path]
            if has_trim and trim_start:
                cmd += ['-ss', str(trim_start)]
            if trim_duration is not None:
                cmd += ['-t', str(trim_duration)]
            last_label = '0:v'

        # Add redaction drawbox filters
        bar_h = f'ih*{redact_size}/100'
        if redact_top:
            filters.append(
                f'[{last_label}]drawbox=x=0:y=0:w=iw:h={bar_h}:color=black:t=fill[rtop]'
            )
            last_label = 'rtop'
        if redact_bottom:
            filters.append(
                f'[{last_label}]drawbox=x=0:y=ih-{bar_h}:w=iw:h={bar_h}:color=black:t=fill[rbot]'
            )
            last_label = 'rbot'

        # Build filter complex
        if filters:
            if last_label not in ('0:v',):
                last_filter = filters[-1]
                filters[-1] = last_filter.rsplit('[', 1)[0] + '[vout]'
                filter_str = ';'.join(filters)
                cmd += ['-filter_complex', filter_str, '-map', '[vout]']
            else:
                filter_str = ';'.join(filters)
                cmd += ['-filter_complex', filter_str]
        # If no filters but needs_reencode (e.g., trim-only with reencode flag),
        # just map video directly — no filter_complex needed

        if not remove_audio:
            cmd += ['-map', '0:a?']
        else:
            cmd += ['-an']

        cmd += ['-c:v', best_encoder]
        if best_encoder == 'libx264':
            cmd += ['-preset', 'fast', '-crf', '23']
        if not remove_audio:
            cmd += ['-c:a', 'aac', '-b:a', '128k']
    else:
        # No re-encoding needed — stream copy (fast)
        # For stream copy, -ss before -i is fastest (seeks by keyframes)
        if has_trim and trim_start:
            cmd += ['-ss', str(trim_start)]
        cmd += ['-i', full_path]
        if trim_duration is not None:
            cmd += ['-t', str(trim_duration)]
        cmd += ['-c:v', 'copy']
        if remove_audio:
            cmd += ['-an']
        else:
            cmd += ['-c:a', 'copy']

    # Re-derive output name in case suffix changed
    output_name = f'{base_name}{suffix}.mp4'
    output_path = os.path.join(export_dir, output_name)
    cmd += ['-movflags', '+faststart', output_path]

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=300
        )
        if result.returncode != 0:
            return jsonify({
                'error': 'ffmpeg failed',
                'details': result.stderr[-500:] if result.stderr else 'Unknown error'
            }), 500

        resp = {
            'success': True,
            'download_url': f'/api/export/download/{output_name}?dir={export_dir}',
            'filename': output_name,
        }
        if pip_failed:
            resp['warning'] = ('PiP compositing requires full ffmpeg with HEVC decoder. '
                              'Install non-free ffmpeg for PiP export. '
                              'Exported front camera only.')
        return jsonify(resp)
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Export timed out (5 min limit)'}), 500
    except FileNotFoundError:
        return jsonify({'error': 'ffmpeg not found. Install it: sudo dnf install ffmpeg-free'}), 500


def _cleanup_old_exports():
    """Remove export temp dirs older than 1 hour."""
    try:
        tmp = tempfile.gettempdir()
        import time
        now = time.time()
        for name in os.listdir(tmp):
            if name.startswith(('dashview_export_', 'dashview_merge_', 'dashview_batch_')):
                path = os.path.join(tmp, name)
                if os.path.isdir(path) and now - os.path.getmtime(path) > 3600:
                    shutil.rmtree(path, ignore_errors=True)
    except Exception:
        pass


@app.route('/api/export/download/<filename>')
def export_download(filename):
    _cleanup_old_exports()
    """Download an exported video file."""
    export_dir = request.args.get('dir', '')
    if not export_dir or not os.path.isdir(export_dir):
        abort(404)
    # Security: only allow files in temp directories
    if not export_dir.startswith(tempfile.gettempdir()):
        abort(403)
    # Sanitize filename to prevent directory traversal
    safe_name = os.path.basename(filename)
    file_path = os.path.realpath(os.path.join(export_dir, safe_name))
    if not file_path.startswith(os.path.realpath(export_dir)):
        abort(403)
    if not os.path.isfile(file_path):
        abort(404)
    mimetype = 'application/zip' if filename.endswith('.zip') else 'video/mp4'
    return send_file(
        file_path, as_attachment=True, download_name=os.path.basename(file_path),
        mimetype=mimetype
    )


def main():
    import argparse
    parser = argparse.ArgumentParser(description='DashView - Dashcam Viewer')
    parser.add_argument('-p', '--port', type=int, default=5000,
                        help='Port to listen on (default: 5000)')
    parser.add_argument('-H', '--host', default='127.0.0.1',
                        help='Host to bind to (default: 127.0.0.1)')
    parser.add_argument('-d', '--directory', default=None,
                        help='Dashcam recordings directory')
    parser.add_argument('--open', action='store_true',
                        help='Open browser automatically')
    args = parser.parse_args()

    global DASHCAM_ROOT
    if args.directory:
        DASHCAM_ROOT = os.path.expanduser(args.directory)

    if not os.path.isdir(DASHCAM_ROOT):
        print(f"Note: Directory '{DASHCAM_ROOT}' does not exist yet.")
        print("You can set it from the UI or create it manually.")

    url = f"http://{args.host}:{args.port}"
    rec = DASHCAM_ROOT
    title = 'DashView v1.0'
    sub = 'Modern Dashcam Viewer for BlackVue on Linux'
    w = max(len(title), len(sub), len(f'Recordings: {rec}'), len(f'URL: {url}')) + 4
    line = '═' * (w + 2)
    print(f"""
╔{line}╗
║  {title:<{w}}║
║  {sub:<{w}}║
╠{line}╣
║  Recordings: {rec:<{w - 14}}║
║  URL: {url:<{w - 6}}║
╚{line}╝
""")

    if args.open:
        import webbrowser
        webbrowser.open(url)

    app.run(host=args.host, port=args.port, debug=False)


if __name__ == '__main__':
    main()
