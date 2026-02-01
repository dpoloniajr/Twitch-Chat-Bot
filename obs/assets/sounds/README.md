# OBS Alert Sounds

Place your custom alert sound files here. Supported formats:
- `.mp3`
- `.wav`
- `.ogg`

## Suggested File Names

- `follow.mp3` - Sound for new followers
- `subscribe.mp3` - Sound for new subscriptions
- `bits.mp3` - Sound for bit cheers
- `raid.mp3` - Sound for raids
- `redemption.mp3` - Sound for channel point redemptions
- `default.mp3` - Fallback sound for any alert type without a specific sound file

## Notes

- Keep file sizes small (< 500KB) for faster loading
- Short sounds (1-3 seconds) work best for alerts
- Test volume levels in OBS before going live
- If a specific sound file is missing, the system will try to play `default.mp3` instead
- Sound playback errors are handled silently (alerts will still display without sound)

## Custom Sounds via Dashboard

You can also upload custom sounds through the dashboard's Alert Config page:

1. Go to Dashboard → Alert Config
2. Select an alert type (Follow, Subscription, etc.)
3. In the Media section, select "Custom Sound..." from the Sound dropdown
4. Upload your custom sound file

Custom sounds uploaded via the dashboard are stored in `/dashboard/uploads/sounds/` and take precedence over files in this directory.

## Getting Sound Files

You can find royalty-free alert sounds from:
- [Freesound.org](https://freesound.org/)
- [Mixkit](https://mixkit.co/free-sound-effects/)
- [ZapSplat](https://www.zapsplat.com/)
