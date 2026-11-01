python3 - <<'PY'
import json
p='/vol2/@appshare/Harness/.dsh/dsh-expression.json'
d=json.load(open(p,encoding='utf-8'))
old=d.get('sendChance')
d['sendChance']=100
d['sendChanceEnabled']=True
json.dump(d,open(p,'w',encoding='utf-8'),ensure_ascii=False,indent=2)
print(f'sendChance: {old} -> 100 (sendChanceEnabled=True)')
print('其他键未动:', sorted(set(d.keys())-{'sendChance'}))
PY
