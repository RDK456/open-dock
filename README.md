# Open Dock

Phone control deck and local PC companion.

## Credits

Open Dock is a modified fork of [Freeze](https://github.com/naveen-devang/Freeze) by [Naveen Devang](https://github.com/naveen-devang), who wrote the original phone deck and PC companion. All credit for the original design and code goes to them. This fork adds its own looks (Studio, Atelier, Signal, Glass, Funk) with per-look navigation, hands-free "hey dock" voice control on the phone and PC, a new icon, and other changes; see the commit history for everything that differs. Like the original, it is licensed under the GNU GPL v3 (see [LICENSE](LICENSE)).

## Download

Get the latest installers from the [Releases page](https://github.com/RDK456/open-dock/releases/latest). After the first install, Open Dock updates itself.

- **Windows:** `Open Dock_*_x64-setup.exe`. Windows may say "Windows protected your PC" because the installer isn't signed; choose **More info → Run anyway**.
- **macOS:** `Open Dock_*_aarch64.dmg` for Apple silicon (M1 and later) or `Open Dock_*_x64.dmg` for Intel. The app isn't notarized by Apple, so the first time, open **System Settings → Privacy & Security** and choose **Open Anyway** (on macOS 14 and earlier, right-click the app and choose **Open**).
- **Android:** `OpenDock.apk`. Allow installs from your browser or file manager when Android asks.

## Run the PC companion (Windows or macOS)

```powershell
cd pc-companion
npm install
npm run tauri dev
```

The Open Dock desktop app listens on port `39421` and displays a pairing QR code. Keep both devices on the same Wi-Fi network. The macOS companion supports Catalina (10.15) and later and must be built on a Mac with Xcode Command Line Tools. On macOS, allow Open Dock in **System Settings → Privacy & Security → Accessibility** so it can send media keys and shortcuts.

## Run the phone app

```powershell
cd phone-app
npm install
npm start
```

Open the project in Expo Go on a phone on the same Wi-Fi. In the **Connect** tab, scan the Wi-Fi QR code in Open Dock for desktop. Pairing details are stored securely on the phone. Use a trusted Wi-Fi network while connected. Manual entry remains available as a fallback.

The phone deck supports multiple pages, custom keyboard shortcuts, app-launch buttons, ordered shortcut sequences, selectable Lucide icons, and per-page button ordering. Paired PCs are saved on the phone and can be switched from **Connect → Paired devices**. To use Android over USB, install Android SDK Platform-Tools, enable USB debugging, connect and authorize one phone, then select **Android USB** and **Set up USB** in the PC app. Scan once when pairing initially; afterward switch between Wi-Fi and USB from the phone's **Connect** screen. Open Dock retains the PC's pairing key and restores ADB forwarding when the authorized phone reconnects.

iOS uses Wi-Fi. iOS does not provide a general-purpose USB data channel from an app to a PC; Apple's External Accessory framework is for compatible MFi accessories. [Apple External Accessory docs](https://developer.apple.com/documentation/externalaccessory)

Android's ADB reverse feature forwards a device port to the host and works with USB-connected physical devices. [Android ADB reverse docs](https://developer.android.com/develop/ui/views/layout/webapps/access-local-server)

The app uses the React Native WebSocket API and the companion protocol documented in [the PC companion README](pc-companion/README.md).

## Release

Run `bash scripts/setup-release-signing.sh` once to create the signing keys and store them as GitHub Actions secrets. Back up `~/.open-dock-signing`: installed apps can't update without those keys.

To ship, run `node scripts/bump-version.ts 1.2.0`, commit, then `git tag v1.2.0 && git push origin v1.2.0`. The **Release** workflow builds Windows, macOS and Android into a draft GitHub release. Publish the draft to make it the latest release.

Updates download only what changed when the release has patches from the previous version. Before you publish, run `python scripts/make-delta.py release <previous version> <old setup.exe> <new setup.exe> <old OpenDock.apk> <new OpenDock.apk> latest.json`, then upload the two `.patch` files and the updated `latest.json`. This needs `pip install bsdiff4`, 7-Zip, and the updater signing key in `TAURI_SIGNING_PRIVATE_KEY`. Without patches, apps download the full installer or APK.

## License

Open Dock is free software under the [GNU General Public License v3.0](LICENSE). `phone-app/` also contains files from Expo's app template, which are MIT licensed (`phone-app/LICENSE`). macOS release builds bundle [mediaremote-adapter](https://github.com/ungive/mediaremote-adapter) (BSD-3-Clause).
