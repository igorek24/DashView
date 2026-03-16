#!/bin/bash
# DashView Installer - supports RHEL/Fedora, Debian/Ubuntu, Arch, openSUSE, and others
set -e

APP_NAME="dashview"
APP_DIR="/opt/dashview"
VENV_DIR="$APP_DIR/venv"
BIN_LINK="/usr/local/bin/dashview"
DESKTOP_FILE="/usr/share/applications/dashview.desktop"

echo "╔══════════════════════════════════════════╗"
echo "║       DashView Installer v1.0            ║"
echo "║    Modern Dashcam Viewer for BlackVue on Linux        ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Check for root
if [ "$EUID" -ne 0 ]; then
    echo "Please run as root (sudo ./install.sh)"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect distro family
detect_distro() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        echo "$ID"
    elif [ -f /etc/redhat-release ]; then
        echo "rhel"
    elif [ -f /etc/debian_version ]; then
        echo "debian"
    elif [ -f /etc/arch-release ]; then
        echo "arch"
    else
        echo "unknown"
    fi
}

DISTRO=$(detect_distro)

# Also check ID_LIKE for derivatives (e.g. Linux Mint -> ubuntu, AlmaLinux -> rhel)
DISTRO_LIKE=""
if [ -f /etc/os-release ]; then
    . /etc/os-release
    DISTRO_LIKE="${ID_LIKE:-}"
fi

echo "Detected distribution: $DISTRO (${DISTRO_LIKE:-(none)})"
echo ""

echo "[1/5] Installing system dependencies..."
install_deps() {
    case "$DISTRO" in
        # RHEL family: AlmaLinux, Rocky, CentOS, Fedora, RHEL
        almalinux|rocky|centos|rhel|fedora)
            dnf install -y python3 python3-pip python3-devel
            ;;
        # Debian family: Debian, Ubuntu, Mint, Pop!_OS, etc.
        debian|ubuntu|linuxmint|pop|elementary|zorin|kali|mx|raspbian)
            apt-get update -qq
            apt-get install -y python3 python3-pip python3-venv python3-dev
            ;;
        # Arch family: Arch, Manjaro, EndeavourOS, Garuda
        arch|manjaro|endeavouros|garuda|artix)
            pacman -Sy --noconfirm python python-pip
            ;;
        # openSUSE family
        opensuse*|sles)
            zypper install -y python3 python3-pip python3-devel
            ;;
        # Void Linux
        void)
            xbps-install -Sy python3 python3-pip python3-devel
            ;;
        # Alpine
        alpine)
            apk add python3 py3-pip python3-dev
            ;;
        # Gentoo
        gentoo)
            emerge --noreplace dev-lang/python dev-python/pip
            ;;
        *)
            # Try to detect via ID_LIKE as a fallback
            if echo "$DISTRO_LIKE" | grep -qiw "rhel\|fedora\|centos"; then
                dnf install -y python3 python3-pip python3-devel 2>/dev/null || \
                yum install -y python3 python3-pip python3-devel
            elif echo "$DISTRO_LIKE" | grep -qiw "debian\|ubuntu"; then
                apt-get update -qq
                apt-get install -y python3 python3-pip python3-venv python3-dev
            elif echo "$DISTRO_LIKE" | grep -qiw "arch"; then
                pacman -Sy --noconfirm python python-pip
            elif echo "$DISTRO_LIKE" | grep -qiw "suse"; then
                zypper install -y python3 python3-pip python3-devel
            else
                echo "Warning: Unrecognized distribution '$DISTRO'."
                echo "Please ensure python3, pip, and venv are installed manually."
                echo ""
                # Check if python3 is available anyway
                if ! command -v python3 &>/dev/null; then
                    echo "Error: python3 not found. Install it and re-run this script."
                    exit 1
                fi
            fi
            ;;
    esac
}

install_deps

# On some Debian/Ubuntu systems, ensurepip may be missing
if ! python3 -m venv --help &>/dev/null; then
    echo "Installing python3-venv (needed for virtual environments)..."
    case "$DISTRO" in
        debian|ubuntu|linuxmint|pop|elementary|zorin|kali|mx|raspbian)
            PYVER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
            apt-get install -y "python3.${PYVER#3.}-venv" 2>/dev/null || \
            apt-get install -y python3-venv
            ;;
    esac
fi

echo ""
echo "[2/5] Creating application directory..."
mkdir -p "$APP_DIR"
cp -r "$SCRIPT_DIR"/* "$APP_DIR/"

echo "[3/5] Setting up Python virtual environment..."
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip -q
"$VENV_DIR/bin/pip" install -r "$APP_DIR/requirements.txt" -q

echo "[4/5] Creating launcher..."
cat > "$BIN_LINK" << 'LAUNCHER'
#!/bin/bash
DASHVIEW_DIR="/opt/dashview"
exec "$DASHVIEW_DIR/venv/bin/python3" "$DASHVIEW_DIR/dashcam_viewer.py" "$@"
LAUNCHER
chmod +x "$BIN_LINK"

echo "[5/5] Creating desktop entry..."
# Copy icon
mkdir -p /usr/share/icons/hicolor/scalable/apps
cp "$APP_DIR/static/img/icon.svg" /usr/share/icons/hicolor/scalable/apps/dashview.svg

cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Name=DashView
Comment=Modern Dashcam Viewer for BlackVue on Linux
Exec=dashview --open
Icon=dashview
Terminal=false
Type=Application
Categories=AudioVideo;Video;Utility;
Keywords=dashcam;video;viewer;gps;
StartupNotify=true
EOF

# Update icon cache if available
gtk-update-icon-cache /usr/share/icons/hicolor 2>/dev/null || true
update-desktop-database /usr/share/applications 2>/dev/null || true

echo ""
echo "Installation complete!"
echo ""
echo "Usage:"
echo "  dashview                      # Start with default ~/dashcam folder"
echo "  dashview -d /path/to/videos   # Specify recordings directory"
echo "  dashview --open               # Auto-open browser"
echo "  dashview -p 8080              # Use a different port"
echo ""
echo "Or launch 'DashView' from your application menu."
echo ""
