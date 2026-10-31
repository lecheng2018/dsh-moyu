echo "=== [1] dsh-expression.json 是否被种入默认值 ==="
python3 -c "
import json
d=json.load(open('/vol2/@appshare/Harness/.dsh/dsh-expression.json'))
print('qqSendResize =', d.get('qqSendResize','<未设置>'))
print('qqSendEdge   =', d.get('qqSendEdge','<未设置>'))
print('packsDir     =', d.get('packsDir','<未设置>'))
"
echo
echo "=== [2] harness.log 里的 meme-bridge 行 ==="
grep -a "meme-bridge" /vol2/@appdata/Harness/harness.log | tail -3
echo
echo "=== [3] 图库目录与白名单一致性 ==="
ls -d /vol2/@appshare/Harness/.dsh/meme-packs 2>/dev/null && echo "~/.dsh/meme-packs 存在 ✓"
ls /vol2/@appshare/Harness/.dsh/meme-packs | head -4
echo
echo "=== [4] send-cache(缩图缓存,尺寸默认值生效后才会出现) ==="
ls -d /vol2/@appshare/Harness/.dsh/meme-packs/.send-cache 2>/dev/null && ls /vol2/@appshare/Harness/.dsh/meme-packs/.send-cache | head -3 || echo "(暂无——还没走过缩图发送)"
