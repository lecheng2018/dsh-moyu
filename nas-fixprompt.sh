python3 - <<'PY'
p='/vol2/@appshare/Harness/.dsh/profiles/web/cordis.patch.yml'
t=open(p,encoding='utf-8').read()
old='''    directPrompt: |

- id: vision-router'''
new='''    directPrompt: |
      聊天风格(日常闲聊时适用,对方派活/说正事时不适用):
      - 主动配表情包:接梗/吐槽/卖萌/感慨时,直接调 send_meme 拿候选,再把挑中的 path(绝对路径)用 qqbot_send_file 发出,不用等对方叫你发;每次至多一张
      - 分条说话:日常闲聊的回复可以用 qq_send 工具拆成 1-3 条发(每调一次发出一条),说完调 qq_close 或直接结束,不要再重复正文
      - 对方在提问或等你交付时:不发表情包、不拆条,给完整回答

- id: vision-router'''
assert old in t, 'anchor not found'
open(p,'w',encoding='utf-8').write(t.replace(old,new,1))
print('directPrompt 已填充(热更新自动生效)')
PY
sleep 3
grep -a "hot\|reload\|zhoukai" /vol2/@appdata/Harness/harness.log | tail -3
