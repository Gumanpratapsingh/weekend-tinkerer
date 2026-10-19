# Life-pet scene: status

Stopped before building (usage limit): no scene code yet, nothing on the phone. Room light is readable without a server change by adding a symlink here, `room.json -> ../../../room/state.json` (the room watcher writes `{"lights":"on"|"off",...}`); fall back to night hours 23:00–06:30.
Next: canvas scene with fox, jelly and pixel styles (`?style=`), a `?demo=` mode, eat/level/party/sleep/hot/worried states from `/api/state`, and the morning recap from a localStorage snapshot taken at 23:00.
