# Wall scenes

One folder per scene: `scenes/<name>/index.html` (+ assets). The wall server serves it at
`http://127.0.0.1:8099/scenes/<name>/`, and `/api/state` has the live agent/laptop/phone data.
To push only one scene to the phone without restarting anything:
`COPYFILE_DISABLE=1 tar --no-xattrs -czf - scenes/<name> | ssh s20phone 'tar -xzf - -C ~/wall'`
