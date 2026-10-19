#!/bin/sh
# Started by Sunshine ("Fighting (Ikemen GO)"): Ikemen GO on display :1, drawn by the Intel GPU through VirtualGL's
# EGL back end (without it, Mesa renders in software and uses ~6 CPU cores).
cd /home/gpsingh/arcade/ikemen
sed -i 's/^Fullscreen *= *0/Fullscreen               = 1/' save/config.ini 2>/dev/null
exec /opt/VirtualGL/bin/vglrun -d egl ./Ikemen_GO_Linux
