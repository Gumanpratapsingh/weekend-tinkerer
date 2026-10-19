# Life-pet

A creature that lives on the Mission Control wall and reacts to real events from `/api/state`, polled every 15 s:

| Event | What the pet does |
|---|---|
| `today.applied` / `total.applied` goes up | food flies in, it chomps, "+1 XP", caption "Ate 2 applications 🍜" |
| XP (`total.applied` + 20 per interview) crosses a level | light burst, "LEVEL n", it grows a bit |
| `total.interviews` goes up | party hat, dancing, confetti for 14 s |
| `laptop.temp` ≥ 80 °C / ≥ 88 °C | warm: blush, sweat, panting; hot: red tint, steam |
| `phone.battery` ≤ 20 | worried face, thought bubble with a low battery |
| room lights off (or 23:00–06:30 if unknown) | dims, nightcap, Zzz; wakes briefly to eat |
| first awake view after 6 am | "Good morning" card: applications, interviews, levels, hottest laptop, lowest battery and lights-off time since 11 pm |

Options: `?style=fox` (default), `?style=jelly`, `?style=pixel`. `?demo=1` cycles through every state with fake data;
`?demo=idle|eat|warm|hot|worried|sleep|party|levelup|recap` pins one. `?hour=` forces the time of day.

Room light: `room.json` is a symlink to `~/room/state.json`, which the room watcher on the phone writes
(`{"lights":"on"|"off",...}`). The wall server serves it as a normal scene file, so no server change was needed.
The overnight snapshot and the last reading live in localStorage (`pet.*`); the scene works without it.

Files: `common.js` (helpers), `style-*.js` (one per creature: background + creature drawing), `pet.js` (data, moods, effects, demo).
