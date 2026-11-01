const fs=require('fs');
const lines=fs.readFileSync('/tmp/qq-verify.jsonl','utf8').split('\n').filter(Boolean);
const ev=[];
for(const l of lines){try{ev.push(JSON.parse(l));}catch(e){}}
const t2s=(t)=>new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
// 1. 最近 5 条 system prompt 的标记检查
let checked=0;
for(let i=ev.length-1;i>=0&&checked<5;i--){
  const e=ev[i];
  if(e.type!=='system/message')continue;
  const s=JSON.stringify(e);
  checked++;
  console.log(`--- system#${i} ${t2s(e.time)} ---`);
  console.log('  directPrompt(主动配表情包):', s.includes('主动配表情包'));
  console.log('  斗图规则/主动斗图:', s.includes('主动斗图'));
  console.log('  抽签命中(本轮命中,可以):', s.includes('本轮命中,可以'));
  console.log('  qqbot_send_file 投递规则:', s.includes('qqbot_send_file'));
  console.log('  send_meme 工具说明:', s.includes('send_meme'));
}
// 2. directPrompt 生效时间点之后的 send_meme 调用
const dpTime=(()=>{for(let i=ev.length-1;i>=0;i--){if(JSON.stringify(ev[i]).includes('主动配表情包'))return ev[i].time;}return 0;})();
console.log('\ndirectPrompt 首次出现时间:', dpTime?t2s(dpTime):'(未出现!)');
let calls=[];
for(const e of ev){
  if(e.type==='tool/call'&&e.data?.name==='send_meme')calls.push({t:e.time,a:e.data.arguments});
}
console.log('send_meme 全部调用:');
calls.forEach(c=>console.log(`  ${t2s(c.t)} ${c.a}`));
// 3. 最近的用户消息(看有没有闲聊机会)
const users=[];
for(const e of ev){if(e.type==='user/message'||(e.data?.source?.kind==='user'&&e.type!=='tool/result')){const s=JSON.stringify(e);if(s.includes('"type":"user/message"'))users.push({t:e.time,txt:(e.data?.message?.content?.[0]?.text||e.data?.content||'').slice(0,40)});}}
console.log('\n最近 8 条用户消息:');
users.slice(-8).forEach(u=>console.log(`  ${t2s(u.t)} ${u.txt.replace(/\n/g,' ')}`));
