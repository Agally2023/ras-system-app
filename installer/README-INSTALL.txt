RAS HATCHERY MONITOR - INSTALL GUIDE
====================================

WINDOWS (the monitor / HMI computer)
  1. Unzip this folder anywhere.
  2. Double-click  Install-Windows.bat
     (use Install-Windows-AutoStart.bat if the app should start by itself when the computer starts).
  3. Open "RAS Hatchery" from the Desktop. It opens in its own window (Edge or Chrome).
  4. Sign in with your RAS account. The computer needs internet or Wi-Fi.
  To remove it: Uninstall-Windows.bat
  If Windows shows a blue "SmartScreen" box: More info, Run anyway. The scripts are plain text you can read.

MAC / LINUX
  Install Node 18 or newer, then run:  ./start.sh   (or: node server.mjs)

NO INSTALL AT ALL
  Open the web version in Chrome or Edge, then use "Install app" in the browser menu.

WHAT THIS CONTAINS
  app/      the program (SCADA, DCS, HMI, dashboard, PLC plan, simulator, admin)
  gateway/  the PLC gateway. Run it on a PC on the same network as the PLC (needs Node 18+):
              cd gateway, npm install, copy .env.example to .env, fill it in, npm start
            It reads the PLC and sends the readings to the cloud, so every screen shows live PLC data over Wi-Fi.
            See gateway/.env.example for the settings.

The app talks to your Supabase project over the internet, so the monitor sees the same data as every other device.
