export PATH=/vol2/@appcenter/nodejs_v24/bin:$PATH
D="/vol2/@appshare/Harness/.dsh/sessions/--vol2-~0040appshare-Harness-.dsh-im--"
S="$(ls -t $D/session-*/session.v4.jsonl.zstd 2>/dev/null | head -1)"
node -e "const fs=require('fs'),zlib=require('zlib');const out=zlib.zstdDecompressSync(fs.readFileSync(process.argv[1]));fs.writeFileSync('/tmp/qq-verify.jsonl',out)" "$S"
node -e "
const fs=require('fs');
const lines=fs.readFileSync('/tmp/qq-verify.jsonl','utf8').split('\n').filter(Boolean);
const ev=[]; for(const l of lines){try{ev.push(JSON.parse(l));}catch(e){}}
// 重启时间(1h前)之后的事件:找最近的 system/message 里有没有 dsh-expression:companion 和命中规则
let companion=0, hit=0, sendMeme=0, lastSys='';
for(const e of ev){
  const s=JSON.stringify(e);
  if(s.includes('dsh-expression:companion')) companion++;
  if(s.includes('本轮命中,可以')) hit++;
  if(s.includes('\"name\":\"send_meme\"')&&s.includes('tool/call')) sendMeme++;
}
console.log('companion 注入出现:', companion);
console.log('抽签命中规则出现:', hit);
console.log('send_meme 调用(全会话):', sendMeme);
// 最近的 system prompt 里贴出 companion 段
for(let i=ev.length-1;i>=0;i--){
  const s=JSON.stringify(ev[i]);
  if(s.includes('dsh-expression:companion')){
    const m=s.match(/dsh-expression:companion[^}]*text\":\"([^\"]{0,600})/);
    console.log('最近 companion 段内容预览:', (m?m[1]:'').slice(0,500));
    break;
  }
}
"
echo "=== 抽签缓存/设置 ==="
python3 -c "
import json
d=json.load(open('/vol2/@appshare/Harness/.dsh/dsh-expression.json'))
print('sendChanceEnabled:',d.get('sendChanceEnabled'),'sendChance:',d.get('sendChance'),'sendMode:',d.get('sendMode','<默认auto>'),'promptEnabled:',d.get('promptEnabled','<默认true>'))"
