B=/vol2/@appshare/Harness/.dsh/profiles/web/node_modules/dsh-meme/memes
echo "=== 内置图库路径存在? ==="
ls -d $B 2>/dev/null && ls $B | head -3 || echo "不存在!"
echo
python3 - <<'PY'
p='/vol2/@appshare/Harness/.dsh/profiles/web/cordis.patch.yml'
t=open(p,encoding='utf-8').read()
root='/vol2/@appshare/Harness/.dsh/profiles/web/node_modules/dsh-meme/memes'
import re
# 找 zhoukai-qqbot 条目,在其 config 下加 sendFile.extraRoots(幂等)
if 'extraRoots' in t.split('- id: vision-router')[0]:
    print('extraRoots 已存在,跳过')
else:
    old='''    access:
      c2cMode: allowlist'''
    new=f'''    sendFile:
      extraRoots:
        - {root}
    access:
      c2cMode: allowlist'''
    assert old in t, 'anchor missing'
    open(p,'w',encoding='utf-8').write(t.replace(old,new,1))
    print('已把内置图库目录加进 sendFile.extraRoots(热更新生效):', root)
PY
