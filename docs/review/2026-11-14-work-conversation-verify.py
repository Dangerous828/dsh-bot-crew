import json,os,sqlite3,subprocess,sys,urllib.request
ST=os.path.expanduser('~/.dsh/state/superagent')
MASTER='orchestrator-bbbb4bafe8b5e5afe49748149f93df3d'
T1='9a0a8727ddecce7ce03d2030c0808dd8'; T2='afdf7ef7e63570ab546605028990c186'
fails=[]
def check(name,cond,detail=''):
    print(('PASS' if cond else 'FAIL'), name, ('| '+detail) if detail else '')
    if not cond: fails.append(name)

od=sqlite3.connect(f'file:{ST}/orchestrator.sqlite?mode=ro',uri=True); od.row_factory=sqlite3.Row
q=lambda s,*a: [dict(r) for r in od.execute(s,a)]
t1=json.loads(q('select value from ticket where id=?',T1)[0]['value'])
t2=json.loads(q('select value from ticket where id=?',T2)[0]['value'])

check('A1 ticket1 scope.conversation=work', t1['mandate']['basis']['scope']['conversation']=='work', t1['mandate']['basis']['scope']['conversation'])
check('A2 ticket2 scope.conversation=work', t2['mandate']['basis']['scope']['conversation']=='work', t2['mandate']['basis']['scope']['conversation'])
check('A3 ticket1 basis.via=addressed/mention', t1['mandate']['basis']['via']=='addressed' and t1['mandate']['basis'].get('addressed')=='mention')
check('A4 ticket1 registeredSessions snapshot', t1['mandate']['basis']['scope'].get('registeredSessions')==['work'])
check('A5 ticket1 trigger thread is team:work:60', bool(q("select thread from trigger_thread where id=?", t1['origin']['triggerId']) and q("select thread from trigger_thread where id=?", t1['origin']['triggerId'])[0]['thread']=='team:work:60'), str(q("select thread from trigger_thread where id=?", t1['origin']['triggerId'])))
check('A6 ticket1 ended completed by executor', t1['ended']['outcome']=='completed' and t1['ended']['by']=='executor')
check('A7 ticket2 ended completed by executor', t2['ended']['outcome']=='completed' and t2['ended']['by']=='executor')
check('A8 ticket1 messageId=60', t1['mandate']['basis']['scope']['messageId']=='60')
check('A9 ticket2 messageId=61', t2['mandate']['basis']['scope']['messageId']=='61')
check('A10 ticket1 has report summary', bool(t1['assignments'][0].get('report',{}).get('summary')))
check('A11 ticket2 has report summary', bool(t2['assignments'][0].get('report',{}).get('summary')))

# main unchanged
conv={r['conv']:r['n'] for r in q("select value->>'$.mandate.basis.scope.conversation' conv, count(*) n from ticket group by conv")}
check('B1 main ticket count still 15', conv.get('main')==15, str(conv))
check('B2 work tickets now 3 (2c23257a+2 new)', conv.get('work')==3, str(conv))
check('B3 no open ticket left', q('select count(*) n from ticket where open is not null')[0]['n']==0)
check('B4 no active ticket left', q('select count(*) n from ticket where active is not null')[0]['n']==0)

# queue
mq=sqlite3.connect(f'file:{ST}/mobileq.db?mode=ro',uri=True); mq.row_factory=sqlite3.Row
qc={r['conversation']:r['n'] for r in mq.execute('select conversation,count(*) n from messages group by conversation')}
check('C1 main queue still 51', qc.get('main')==51, str(qc))
check('C2 work queue 5->7', qc.get('work')==7, str(qc))
rows={r['id']:dict(r) for r in mq.execute('select id,conversation,request_id,read_at from messages where id in (60,61)')}
check('C3 msg60 conversation=work', rows[60]['conversation']=='work')
check('C4 msg61 conversation=work', rows[61]['conversation']=='work')
check('C5 msg60/61 request_id preserved', rows[60]['request_id']=='work-ticket-acceptance-20261114-174203' and rows[61]['request_id']=='work-ticket-running-20261114-174406')

# artifacts
c1='/tmp/work-ticket-canary-20261114-174203/canary.txt'
check('D1 canary.txt exists', os.path.exists(c1))
if os.path.exists(c1):
    body=open(c1).read()
    check('D2 canary text exact', body.strip()=='WORK-CONVERSATION-TICKET-CANARY 20261114-174203', repr(body))
    check('D3 canary 48 bytes', os.path.getsize(c1)==48, str(os.path.getsize(c1)))
c2='/tmp/work-ticket-running-20261114-174406/run.txt'
check('D4 run.txt exists', os.path.exists(c2))
if os.path.exists(c2):
    lines=open(c2).read().splitlines()
    check('D5 run.txt two lines with done', lines==['RUN-CONVERSATION 20261114-174406','done'], repr(lines))

# archive guard
ws=json.load(open(os.path.expanduser('~/.dsh/storages/workspace.json')))
arch=set(ws['global']['archivedSessionIds'])
check('E1 worker of ticket1 archived', 'worker-'+T1 in arch)
check('E2 worker of ticket2 archived', 'worker-'+T2 in arch)
check('E3 master NOT archived', MASTER not in arch)
check('E4 master absent from any orchestrator entry', MASTER not in [a for a in arch if a=='orchestrator-bbbb4bafe8b5e5afe49748149f93df3d'])

# /state
st=json.loads(subprocess.run(['curl','-s','-m','8','-H','Host:127.0.0.1:3082','-H','x-orchestrator-request:1','http://127.0.0.1:3082/orchestrator/api/state'],capture_output=True,text=True).stdout)
check('F1 /state 200 parsed, masterId matches', st.get('masterId')==MASTER)
# 全局 pause 是别人也能操作的共享开关（手机 owner 的按钮验收会按它），
# 所以这里只记录值、不判 PASS/FAIL：本轮派票窗口内 paused 恒为 False 已由 §5.1 的现场快照钉住。
print('INFO F2 paused at recheck =', st.get('paused'), '(shared switch; see report §5.1 for the in-window value)')
check('F3 load drained running=0 queued=0', st['load']['running']==0 and st['load']['queued']==0, str(st['load']))
check('F4 all health ready', all(v['state']=='ready' for v in st['health'].values()), str({k:v['state'] for k,v in st['health'].items()}))
check('F5 no master_archived watchdog alert', not any(a.get('kind')=='master_archived' for a in (st.get('watchdog') or {}).get('alerts',[])))

# timeline sharding
cred=json.load(open(os.path.expanduser('~/.config/crew-desktop/credential.json')))
H={'x-crew-device':cred['deviceId'],'x-crew-credential':cred['token']}
def tl(s):
    r=urllib.request.urlopen(urllib.request.Request(cred['base']+f'/api/mobile/timeline?session_id={s}',headers=H),timeout=10)
    return json.loads(r.read())
m=tl('main'); w=tl('work')
mid=[i['id'] for i in m['items']]; wid=[i['id'] for i in w['items']]
check('G1 m60/m61 only in work', 'm60' in wid and 'm61' in wid and 'm60' not in mid and 'm61' not in mid)
check('G2 work timeline session_id echo', w.get('session_id')=='work' and w.get('session_api')==1)
check('G3 main timeline session_id echo', m.get('session_id')=='main' and m.get('session_api')==1)
check('G4 main items still 78', len(m['items'])==78, str(len(m['items'])))
check('G5 main tasks 15 / work tasks 3', len(m.get('tasks') or [])==15 and len(w.get('tasks') or [])==3, f"{len(m.get('tasks') or [])}/{len(w.get('tasks') or [])}")
groups={g['id']:g['ticket_count'] for g in (w.get('groups',{}).get('groups') or [])}
check('G6 groups counts main=15 work=3', groups.get('main')==15 and groups.get('work')==3, str(groups))

od.close(); mq.close()
print('\nFAILS:',len(fails), fails)
sys.exit(0 if not fails else 1)
