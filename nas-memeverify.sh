export PATH=/vol2/@appcenter/nodejs_v24/bin:$PATH
echo "=== [1] harness 是否重启过(zhoukai.7/8 生效前提) ==="
ps -o pid,etime,cmd -p $(pgrep -f "dsh.*web --no-open" | head -1) 2>/dev/null | tail -1 | awk '{print "进程已运行:", $2, $3}'
echo
echo "=== [2] 缩图缓存(300px 链路产物) ==="
ls /vol2/@appshare/Harness/.dsh/meme-packs/.send-cache/ 2>/dev/null | head -5 || echo "(空——还没有 QQ 侧缩图发送记录)"
echo
echo "=== [3] 绑定后 QQ 会话里的表情包链路(最新会话) ==="
D="/vol2/@appshare/Harness/.dsh/sessions/--vol2-~0040appshare-Harness-.dsh-im--"
S="$(ls -t $D/session-*/session.v4.jsonl.zstd 2>/dev/null | head -1)"
node -e "const fs=require('fs'),zlib=require('zlib');const out=zlib.zstdDecompressSync(fs.readFileSync(process.argv[1]));fs.writeFileSync('/tmp/qq-verify.jsonl',out)" "$S"
echo "send_meme 调用次数: $(grep -ao '\"name\":\"send_meme\",\"arguments\"' /tmp/qq-verify.jsonl | wc -l)"
echo "qqbot_send_file 调用次数: $(grep -ao '\"name\":\"qqbot_send_file\",\"arguments\"' /tmp/qq-verify.jsonl | wc -l)"
echo "白名单拒绝错误: $(grep -ac '不在允许的目录内' /tmp/qq-verify.jsonl)"
echo "最近一次 send_meme 参数: $(grep -ao '\"name\":\"send_meme\",\"arguments\":\"[^\"]*\"' /tmp/qq-verify.jsonl | tail -1)"
echo "最近一次 qqbot_send_file 参数: $(grep -ao '\"name\":\"qqbot_send_file\",\"arguments\":\"[^\"]*\"' /tmp/qq-verify.jsonl | tail -1)"
