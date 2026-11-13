#!/usr/bin/env bash
set -euo pipefail
project=/home/ubuntu/e2e-projects/neteco-playwright-1.62.1
native="$project/.native-test-fix-20261112"
mode="${1:-}"
case "$mode" in validate|serve|smoke) ;; *) exit 64;; esac
python3 - "$project" <<'PY'
from pathlib import Path
import os,sys,subprocess,shutil,json
project=Path(sys.argv[1])
paths=[project/'.browser-cache-test-fix-20261112',project/'.native-test-fix-20261112']
used=sum(int(line.split()[0]) for line in subprocess.check_output(['du','-s','-B1',*map(str,paths)],text=True).splitlines())
mem=dict((x.split(':')[0],int(x.split()[1])*1024) for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith(('MemAvailable:','SwapFree:')))
free=shutil.disk_usage(project)
peak=2*1024**3
assert used+128*1024**2<=1_000_000_000,'private_profile_disk_budget_insufficient'
assert free.free-128*1024**2>=max(10*1024**3,int(free.total*.1)),'disk_reserve_insufficient'
assert sum(mem.values())>peak+4*1024**3,'host_memory_reserve_insufficient'
cg=Path('/sys/fs/cgroup')/Path('/proc/self/cgroup').read_text().strip().split('::')[1].lstrip('/')
for p in [cg,*cg.parents]:
 if str(p).startswith('/sys/fs/cgroup'):
  for name in ['memory.max','memory.high']:
   if (p/name).exists() and (value:=(p/name).read_text().strip())!='max':
    assert int(value)-int((p/'memory.current').read_text())>=peak,'cgroup_memory_insufficient'
print(json.dumps({'gate':'PASS','private_bytes':used,'profile_and_artifact_budget':128*1024**2,'free_bytes':free.free,'RAM_peak':peak,'workers':1,**mem}),flush=True)
PY
exec flock -n /run/lock/beply-ai-heavy-work.lock sudo -n unshare --mount --propagation private --fork /bin/bash -c '
set -euo pipefail
project="$1"; native="$2"; mode="$3"
mount --bind "$native/ld.so.cache" /etc/ld.so.cache
install -d -o ubuntu -g ubuntu -m 0700 "$native/tmp"
case "$mode" in
 validate) set -- node "$project/node_modules/playwright/cli.js" install --only-shell --no-progress chromium firefox webkit ;;
 serve) set -- node --require "$project/stdin-lifecycle-test-fix-20261112.cjs" "$project/node_modules/playwright/cli.js" run-server --host 127.0.0.1 --port 8997 --path /neteco-ci-browser --max-clients 1 ;;
 smoke) set -- node "$project/smoke-test-fix-20261112.cjs" ;;
esac
exec runuser -u ubuntu -- env -u PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS -u PW_HOST_PLATFORM_OVERRIDE \
 LD_LIBRARY_PATH="$native/usr/lib/aarch64-linux-gnu" \
 XDG_DATA_DIRS="$native/usr/share:/usr/local/share:/usr/share" \
 __EGL_VENDOR_LIBRARY_FILENAMES="$native/usr/share/glvnd/egl_vendor.d/50_mesa.json" \
 PLAYWRIGHT_BROWSERS_PATH="$project/.browser-cache-test-fix-20261112" TMPDIR="$native/tmp" "$@"
' neteco-test-fix "$project" "$native" "$mode"
