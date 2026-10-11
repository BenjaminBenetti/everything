const root = document.getElementById('root');
const dialog = document.getElementById('dialog');
const storageKey = 'everything-ui-concept-v1';
const paths = {
 plug:'<path d="M9 3v5m6-5v5M5 8h14M7 8v4a5 5 0 0 0 10 0V8m-5 9v4"/>',
 message:'<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
 question:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3h.01"/>',
 home:'<path d="m3 10 9-7 9 7v11h-6v-7H9v7H3V10Z"/>',
 arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
 back:'<path d="m14 6-6 6 6 6"/>',
 up:'<path d="M12 19V5m-6 6 6-6 6 6"/>',
 grid:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
 bell:'<path d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 8H3c0-1 3-1 3-8Zm4 12h4"/>',
 folder:'<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11H3V7Z"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',
 check:'<path d="m5 12 4 4L19 6"/>',
 checks:'<path d="m2 12 4 4L16 6m-5 9 2 2L23 7"/>',
 search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
 edit:'<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15l-1 5Z"/>',
 lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
 logout:'<path d="M9 3H4v18h5m5-15 6 6-6 6m-6-6h12"/>',
 file:'<path d="M14 2H5v20h14V7l-5-5v5h5M8 12h8m-8 4h6"/>',
 external:'<path d="M14 3h7v7m0-7L10 14M10 4H4v16h16v-6"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 close:'<path d="m6 6 12 12M6 18 18 6"/>',
 panel:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
 sparkle:'<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z"/>',
 phone:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
 share:'<path d="M12 16V2m-4 4 4-4 4 4M7 10H4v12h16V10h-3"/>',
 settings:'<path d="M3 6h18M3 12h18M3 18h18"/><circle cx="8" cy="6" r="2" fill="var(--surface-page)"/><circle cx="16" cy="12" r="2" fill="var(--surface-page)"/><circle cx="10" cy="18" r="2" fill="var(--surface-page)"/>'
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.sparkle}</svg>`; }
function logo() { return '<svg class="logo" viewBox="0 0 40 40" fill="currentColor" aria-hidden="true"><path d="m9 8 9 6 13-6M18 14l7 9 11-4M25 23l6 8M25 23l-11 2-6 6M14 25 4 19" fill="none" stroke="currentColor" stroke-width="1" opacity=".24"/><circle cx="20" cy="4" r="1.9"/><circle cx="31" cy="8" r="2.3"/><circle cx="36" cy="19" r="1.7"/><circle cx="31" cy="31" r="2.4"/><circle cx="20" cy="36" r="1.8"/><circle cx="8" cy="31" r="2"/><circle cx="4" cy="19" r="1.9"/><circle cx="9" cy="8" r="1.6"/><circle cx="18" cy="14" r="2.7"/><circle cx="25" cy="23" r="3.1"/><circle cx="14" cy="25" r="2.2"/></svg>'; }
function wordmark(cls='') { return `<div class="wordmark ${cls}">${logo()}<span>everything</span></div>`; }
function flower() { return '<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.15" aria-hidden="true"><ellipse cx="20" cy="20" rx="6" ry="16"/><ellipse cx="20" cy="20" rx="6" ry="16" transform="rotate(60 20 20)"/><ellipse cx="20" cy="20" rx="6" ry="16" transform="rotate(120 20 20)"/><circle cx="20" cy="20" r="3" fill="currentColor"/></svg>'; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function initials(name) { return esc(name.trim().split(/\s+/).map(x=>x[0]).slice(0,2).join('').toUpperCase()); }
function avatar(agent, small=false) { return `<span class="${small?'mini-avatar':'avatar'} ${agent.color}">${small?initials(agent.name):flower()}</span>`; }
function initialData() {
 const now = Date.now();
 return {
  agents:[
   {id:'first',name:'My agent',role:'Your everyday collaborator',color:'',unread:true,lastContactAt:now-25*60000},
   {id:'second',name:'Second agent',role:'A little room for another perspective',color:'purple',unread:true,lastContactAt:now-90*60000}
  ],
  messages:{
   first:[
    {id:'first-request',role:'user',text:'Can you put together a direction for Everything’s interface?',time:'10:42',at:now-25*60000},
    {id:'first-start',role:'agent',text:'Of course. I’m exploring a few directions, starting with something calm and conversation-first.',time:'10:42',at:now-25*60000},
    {id:'first-artifact',role:'agent',text:'Here’s the first direction. A simple home for your agents, with shared work right in the conversation. Take a look when you have a moment.',time:'10:46',at:now-4*60000,artifact:true,notify:true,unread:true,title:'A first direction, ready for you.'}
   ],
   second:[
    {id:'second-request',role:'user',text:'Help me plan what we should work on next.',time:'09:20',at:now-90*60000},
    {id:'second-question',role:'agent',text:'I have a few ideas for what comes next. Would you like to focus on the interface, or map out the first thing we should build?',time:'10:30',at:now-12*60000,notify:true,unread:true,title:'A quick question before I start.'}
   ]
  }, notifications:false, demoProvider:null, dashboardVersion:1
 };
}
let data = initialData();
try { const saved=JSON.parse(localStorage.getItem(storageKey)); if(saved?.agents?.length && saved.messages) data=saved; } catch {}
// Preserve connections made in the earlier ChatGPT-only preview.
if(data.demoProvider===undefined)data.demoProvider=data.chatgptDemoConnected===true?'chatgpt':null;
delete data.chatgptDemoConnected;
let screen='login', activeId=data.agents[0].id, chatReturn='dashboard', panel=false, drafts={}, pending=new Map(), toastTimer;
let renderedScreen='', renderedAgent='', renderedPanel=false;
prepareDashboardData();
function save(){try{localStorage.setItem(storageKey,JSON.stringify(data))}catch{}}
function active(){return data.agents.find(a=>a.id===activeId)||data.agents[0]}
function toast(text){const el=document.getElementById('toast');el.textContent=text;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),3500)}
function navigate(next){screen=next;dialog.close();closeArtifact(true);render();window.parent.postMessage({type:'screen',screen:screen==='updates'?'dashboard':screen==='artifacts'?'agents':screen},location.origin)}
function openAgent(id){
 const agent=data.agents.find(a=>a.id===id);if(!agent)return;
 if(screen!=='chat')chatReturn=['dashboard','updates','agents','artifacts'].includes(screen)?screen:'dashboard';
 activeId=id;agent.unread=false;agent.lastContactAt=Date.now();
 for(const message of data.messages[id]||[])message.unread=false;
 save();panel=false;navigate('chat');
}
function prepareDashboardData(){
 // Upgrade earlier demo saves without replacing names, conversations, or read state.
 const legacy=data.dashboardVersion!==1,now=Date.now();
 for(const [agentIndex,a] of data.agents.entries()){
  const messages=data.messages[a.id]||[];
  const latestAgent=messages.filter(m=>m.role==='agent').at(-1);
  messages.forEach((m,index)=>{
   m.id??=`saved-${a.id}-${index}`;
   m.at??=now-(agentIndex+1)*30*60000-(messages.length-index)*60000;
   if(legacy&&m===latestAgent){m.notify=true;m.unread=!!a.unread}
  });
  if(!Number.isFinite(a.lastContactAt))a.lastContactAt=messages.filter(m=>m.role==='user').at(-1)?.at||0;
 }
 data.dashboardVersion=1;save();
}
function updates(){
 return data.agents.flatMap(agent=>(data.messages[agent.id]||[])
  .filter(message=>message.role==='agent'&&message.notify)
  .map(message=>({agent,message})))
  .sort((a,b)=>Number(!!b.message.unread)-Number(!!a.message.unread)||b.message.at-a.message.at);
}
function unreadCount(){return updates().filter(item=>item.message.unread).length}
function relativeTime(at){
 const minutes=Math.max(0,Math.floor((Date.now()-at)/60000));
 if(minutes<1)return 'Just now';if(minutes<60)return `${minutes} min ago`;
 const hours=Math.floor(minutes/60);if(hours<24)return `${hours} hr ago`;
 const days=Math.floor(hours/24);return `${days} ${days===1?'day':'days'} ago`;
}
function openUpdate(id){
 const item=updates().find(item=>item.message.id===id);if(!item)return;
 openAgent(item.agent.id);
 requestAnimationFrame(()=>{
  const message=document.getElementById(`message-${id}`);
  message?.scrollIntoView({block:'center',behavior:'instant'});
  message?.classList.add('message-target');
  setTimeout(()=>message?.classList.remove('message-target'),1400);
  document.getElementById('message-input')?.focus({preventScroll:true});
 });
}
function updateCard({agent,message}){
 const type=message.artifact?'Artifact':message.text.includes('?')?'Question':'Message';
 const typeIcon=message.artifact?'file':message.text.includes('?')?'question':'message';
 return `<button class="dashboard-update ${message.unread?'unread':''}" data-update="${esc(message.id)}" aria-label="${message.artifact?'Review and reply to':'Reply to'} ${esc(agent.name)}" aria-describedby="update-preview-${esc(message.id)}">
  ${avatar(agent,true)}
  <span class="update-copy"><span class="update-meta"><strong>${esc(agent.name)}</strong><span class="update-type" title="${type}">${icon(typeIcon)}<span class="sr-only">${type}</span></span>${message.unread?'<span class="dot" aria-label="Unread"></span>':''}<small>${relativeTime(message.at)}</small></span><span class="update-excerpt" id="update-preview-${esc(message.id)}">${esc(message.text)}</span></span>
  <span class="update-open" aria-hidden="true">${icon('back')}</span>
 </button>`;
}
function updatesEmpty(){return `<div class="dashboard-empty">${icon('check')}<h3>You’re all caught up.</h3><p>New messages and shared work will appear here.</p><button class="text-button" data-nav="agents">Visit your team →</button></div>`}
function recentRow(agent){
 const latest=(data.messages[agent.id]||[]).at(-1);
 return `<button class="recent-conversation" data-agent="${esc(agent.id)}" aria-label="Continue with ${esc(agent.name)}">${avatar(agent,true)}<span class="recent-copy"><span class="recent-name">${esc(agent.name)}${agent.unread?'<span class="dot" aria-label="Unread message"></span>':''}</span><span class="recent-preview">${latest?.role==='user'?'You: ':''}${esc(latest?.text||'Start a conversation.')}</span><small>${relativeTime(agent.lastContactAt)}</small></span>${icon('arrow')}</button>`;
}
function dashboardPage(){
 const items=updates(),count=unreadCount();
 const recent=[...data.agents].filter(a=>a.lastContactAt>0).sort((a,b)=>b.lastContactAt-a.lastContactAt).slice(0,5);
 return `${topbar()}<section class="content dashboard-content"><div class="content-inner dashboard-inner">
  <div class="page-heading dashboard-heading"><div><div class="eyebrow">Your space, at a glance</div><h1>Welcome back.</h1><p>${count?`${count===1?'There’s an update':'There are updates'} waiting for you.`:'Pick up a conversation or see what your team has shared.'}</p></div></div>
  <div class="dashboard-grid">
   <section class="dashboard-updates" aria-labelledby="updates-heading"><div class="dashboard-section-heading"><h2 id="updates-heading">Updates for you ${count?`<span class="updates-count">${count} new</span>`:''}</h2><button class="text-button" data-nav="updates">View all ${icon('arrow')}</button></div><div class="updates-feed">${items.slice(0,8).map(updateCard).join('')||updatesEmpty()}</div></section>
   <aside class="dashboard-recent" aria-labelledby="recent-heading"><div class="dashboard-section-heading"><h2 id="recent-heading">Recent conversations</h2></div><p class="recent-intro">Pick up where you left off.</p><div class="recent-list">${recent.map(recentRow).join('')||'<div class="recent-empty">Your conversations will appear here as you talk to your team.</div>'}</div><button class="team-link" data-nav="agents">See your whole team ${icon('arrow')}</button><div class="dashboard-phone">${icon('phone')}<div><strong>Keep the conversation going.</strong><p>Get updates on your phone, too.</p><button class="text-button" data-notifications>${data.notifications?'Manage notifications':'Set up notifications'} →</button></div></div></aside>
  </div>
 </div></section>`;
}

function gridArt(cls=''){return `<div class="theme-art ${cls}" aria-hidden="true"><svg viewBox="0 0 360 360" fill="none"><g class="art-grid" stroke="currentColor" stroke-width="1"><path d="M0 60h360M0 120h360M0 180h360M0 240h360M0 300h360M60 0v360M120 0v360M180 0v360M240 0v360M300 0v360" opacity=".5"/><path d="M60 240v-60h60v-60h120v120h60" stroke-width="2"/><g fill="currentColor" stroke="none"><rect x="55" y="235" width="10" height="10"/><rect x="115" y="115" width="10" height="10"/><rect x="235" y="115" width="10" height="10"/><rect x="295" y="235" width="10" height="10"/></g></g></svg></div>`}
function login(){return `<main class="login"><section class="welcome">${wordmark()}<div class="welcome-copy"><h1>The only app<br><em>you need.</em></h1><p>Get everything done in one place.<br>If what you need doesn’t exist yet, Everything can build it.</p></div><div class="welcome-bottom"><span class="dot"></span>Your world, a little more together.</div>${gridArt()}</section><section class="login-right">${wordmark('mobile-brand')}${gridArt('mobile-theme-art')}<form id="sign-in" class="login-form" autocomplete="off"><div class="eyebrow">Your personal agent</div><h2>Welcome back.</h2><p class="login-subtitle">Your agents are here.<br>Pick up wherever you left off.</p><label class="field">Username<input name="demo-username" placeholder="Your username" value="you" autocomplete="off" spellcheck="false"></label><label class="field">Password<input name="demo-password" type="password" placeholder="Enter your password" autocomplete="off"></label><button type="submit" class="button primary login-submit">Sign in ${icon('arrow')}</button></form><div class="login-foot">${icon('lock')}A private place for you and your agents.</div></section></main>`}
function sidebar(){return `<aside class="sidebar">${wordmark()}<nav aria-label="Workspace"><button data-nav="dashboard" class="nav-item ${screen==='dashboard'?'active':''}">${icon('home')}Home</button><button data-nav="agents" class="nav-item ${screen==='agents'?'active':''}">${icon('grid')}Your team</button><button data-nav="updates" class="nav-item ${screen==='updates'?'active':''}">${icon('bell')}Updates${unreadCount()?`<span class="nav-count">${unreadCount()}</span>`:''}</button><button data-nav="artifacts" class="nav-item ${screen==='artifacts'?'active':''}">${icon('folder')}Artifacts</button></nav><div class="sidebar-section"><span class="eyebrow">Your team</span><button class="icon-button" data-create aria-label="Create an agent">${icon('plus')}</button></div><div>${data.agents.map(a=>`<button class="side-agent ${screen==='chat'&&a.id===activeId?'current':''}" data-agent="${esc(a.id)}">${avatar(a,true)}<span class="name">${esc(a.name)}</span>${a.unread?'<span class="dot"></span>':''}</button>`).join('')}</div><div class="sidebar-bottom"><div class="space-card"><span class="dot"></span>${unreadCount()?'Your team has something to share.':'All caught up? We’re still here.'}</div><div class="profile"><div class="profile-avatar">Y</div><span>Your workspace<small>Just for you</small></span><button class="icon-button" data-nav="login" aria-label="Sign out">${icon('logout')}</button></div></div></aside>`}
function mobileNav(){return `<nav class="mobile-nav" aria-label="Workspace">${[['dashboard','home','Home'],['agents','grid','Team'],['updates','bell','Updates'],['artifacts','folder','Artifacts']].map(([view,i,label])=>`<button data-nav="${view}" class="${screen===view?'active':''}">${icon(i)}${label}${view==='updates'&&unreadCount()?`<span class="mobile-unread" aria-label="${unreadCount()} unread">${unreadCount()}</span>`:''}</button>`).join('')}</nav>`}
function topbar(){return `<header class="topbar">${wordmark('mobile-wordmark')}<div class="breadcrumb">Your workspace ${icon('back').replace('<svg','<svg style="transform:rotate(180deg);width:10px"')}<span>${screen==='dashboard'?'Home':screen==='agents'?'Your team':screen==='updates'?'Updates':'Artifacts'}</span></div><div class="topbar-right"><span class="date">A little space to get things done.</span>${providerButton()}<button class="icon-button" data-notifications aria-label="Notification settings">${icon('bell')}</button><button class="icon-button" data-nav="login" aria-label="Sign out">${icon('logout')}</button></div></header>`}
function agentCard(a){const m=(data.messages[a.id]||[]).filter(m=>m.role==='agent').at(-1);return `<article class="agent-card"><button class="icon-button rename" data-rename="${esc(a.id)}" aria-label="Rename ${esc(a.name)}">${icon('edit')}</button><button class="agent-open" data-agent="${esc(a.id)}">${avatar(a)}<h2>${esc(a.name)}</h2><p class="agent-role">${esc(a.role)}</p><p class="agent-preview">${esc(m?.artifact?'“I’ve put together a first direction. Take a look when you have a moment.”':m?.text||'What would you like to do together?')}</p><div class="card-bottom"><span class="dot"></span>${a.unread?'Something to share':'Ready when you are'}<span class="time">${a.unread?'4 min ago':'Available'}</span>${icon('arrow')}</div></button></article>`}
function cards(filter=''){const agents=data.agents.filter(a=>(a.name+' '+a.role).toLowerCase().includes(filter.toLowerCase()));return agents.map(agentCard).join('')+(!filter?`<button class="new-card" data-create>${icon('plus')}<span><strong>Make room for someone new</strong><small>Create and name an agent</small></span></button>`:!agents.length?'<p class="empty-search">No matching agents. Try another name.</p>':'')}
function agentsPage(){return `${topbar()}<section class="content"><div class="content-inner"><div class="page-heading"><div><h1>Your team.</h1><p>One place for whatever’s on your mind.</p></div><button class="button primary" data-create>${icon('plus')}New agent</button></div><div class="list-tools"><h2 class="section-label">Your team <small>${data.agents.length}</small></h2><label class="search">${icon('search')}<span class="sr-only">Search agents</span><input id="search" placeholder="Find an agent…" type="search"></label></div><div class="agent-grid" id="agents-grid">${cards()}</div><p class="workspace-note">${icon('edit')}These are your agents. Give them names that feel like yours.</p></div></section>`}
function updatesPage(){return `${topbar()}<section class="content"><div class="content-inner"><div class="page-heading"><div><h1>Your updates.</h1><p>Messages and shared work from your team.</p></div>${unreadCount()?`<span class="updates-count">${unreadCount()} new</span>`:''}</div><div class="updates-feed">${updates().map(updateCard).join('')||updatesEmpty()}</div></div></section>`}
function artifactsPage(){return `${topbar()}<section class="content"><div class="content-inner"><div class="page-heading"><div><h1>Made together.</h1><p>A home for the things your agents share with you.</p></div></div><button class="activity-card" data-artifact><span class="artifact-thumbnail">${icon('file')}</span><span><strong>Everything · A first direction</strong><p>A calm, conversation-first interface.</p><small>Shared by ${esc(data.agents[0].name)} · Today</small></span>${icon('panel')}</button></div></section>`}
function renderMessage(m,a){return `<div id="message-${esc(m.id)}" class="message ${m.role==='user'?'user':'agent'}">${m.role==='agent'?`<div class="message-author">${avatar(a,true)}${esc(a.name)}</div>`:''}<div class="bubble">${esc(m.text)}</div>${m.artifact?`<button class="artifact-card" data-artifact><span class="artifact-thumbnail">${icon('file')}</span><span><strong>Everything · A first direction</strong><small>Shared artifact · Open to explore</small></span>${icon('panel')}</button>`:''}<div class="stamp">${esc(m.time)}${m.role==='user'?icon('checks'):''}</div></div>`}
function chatPanel(){return `<aside class="sidepanel" aria-label="Shared work"><div class="panel-heading"><h2>Around this conversation</h2><button class="icon-button" data-panel aria-label="Close shared work">${icon('close')}</button></div><div class="panel-label">In the background</div><div class="detail-item">${icon('clock')}<span>Exploring interface directions<small>You can keep the conversation going.</small></span></div><div class="detail-item">${icon('check')}<span>First concept shared<small>Ready whenever you are.</small></span></div><div class="panel-label">Shared with you</div><button class="panel-artifact" data-artifact>${icon('file')}<span>A first direction<small>Everything · Interface notes</small></span></button><div class="notify-note">${icon('bell')}<p>Step away whenever you like.<br>We can let you know when there’s news.</p><button class="text-button" data-notifications>${data.notifications?'Manage notifications':'Set up notifications'} →</button></div></aside>`}
function chatPage(){const a=active();return `<header class="topbar chat-topbar"><div class="chat-person"><button class="icon-button mobile-back" data-nav="${chatReturn}" aria-label="Back to ${chatReturn==='dashboard'?'home':chatReturn==='updates'?'updates':'your team'}">${icon('back')}</button>${avatar(a,true)}<div><h1>${esc(a.name)}</h1><p><span class="dot"></span>Here when you need me</p></div></div><div class="chat-actions">${providerButton()}<button class="icon-button" data-rename="${esc(a.id)}" aria-label="Agent settings">${icon('settings')}</button><button class="text-button" data-panel aria-label="Toggle shared work" aria-expanded="${panel}">${icon('panel')}Shared work</button></div></header><div class="conversation-layout"><section class="conversation" aria-label="Conversation with ${esc(a.name)}"><div class="messages" id="messages" role="log" aria-live="polite" aria-relevant="additions"><div class="day-divider">TODAY</div>${(data.messages[a.id]||[]).map(m=>renderMessage(m,a)).join('')}${pending.has(a.id)?`<div class="message agent" id="typing"><div class="message-author">${avatar(a,true)}${esc(a.name)}</div><div class="typing" aria-label="Preparing a reply"><i></i><i></i><i></i></div></div>`:''}</div><div class="composer-area"><div class="suggestions"><button data-suggest="Let’s explore this direction.">Let’s explore this</button><button data-suggest="Give me a quick update.">Give me a quick update</button></div><form class="composer" id="composer"><label class="sr-only" for="message-input">Message ${esc(a.name)}</label><textarea id="message-input" rows="1" placeholder="Message ${esc(a.name)}…" maxlength="4000">${esc(drafts[a.id]||'')}</textarea><div class="composer-tools"><span class="composer-caption">Anything on your mind.</span><button class="send" type="submit" aria-label="Send message" ${drafts[a.id]?.trim()?'':'disabled'}>${icon('up')}</button></div></form><p class="composer-footer">Your conversation stays here. The work keeps moving.</p></div></section>${panel?chatPanel():''}</div>`}
function render(){
 const changed=renderedScreen&&(screen!==renderedScreen||(screen==='chat'&&activeId!==renderedAgent));
 const enteringPanel=!changed&&panel&&!renderedPanel;
 const update=()=>{
  root.innerHTML=screen==='login'?login():`<div class="shell ${screen==='chat'?'chat-shell':''}">${sidebar()}<main class="main">${screen==='dashboard'?dashboardPage():screen==='agents'?agentsPage():screen==='updates'?updatesPage():screen==='artifacts'?artifactsPage():chatPage()}</main>${mobileNav()}</div>`;
  bind();if(screen==='chat')scrollChat();
 };
 if(changed){
  const kind=renderedScreen==='login'&&screen!=='login'?'signin':'content';
  const order=['login','dashboard','agents','updates','artifacts','chat'];
  EverythingMotion.transition(update,{kind,direction:order.indexOf(screen)<order.indexOf(renderedScreen)?-1:1});
 }else{EverythingMotion.finish();update();}
 if(enteringPanel)EverythingMotion.enter(root.querySelector('.sidepanel'),'panel');
 renderedScreen=screen;renderedAgent=activeId;renderedPanel=panel;
}
function scrollChat(){requestAnimationFrame(()=>{const el=document.getElementById('messages');if(el)el.scrollTop=el.scrollHeight})}
function timeNow(){return new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}
function replyFor(text){const lower=text.toLowerCase();if(/stop|pause|wait|hold on/.test(lower))return 'Of course. I’ll pause here. What would you like to change?';if(/status|update|progress/.test(lower))return 'The first direction is ready in our shared artifact. I’m exploring the next variation, and I’ll bring it to you when it’s worth a look.';if(/phone|notification|iphone/.test(lower))return 'We can keep this same conversation on your phone. Open notification settings to see the Home Screen and notification setup.';if(/explore|direction|design|concept/.test(lower))return 'Let’s work through it together. We could start with the agent picker, or make the conversation feel a little more personal. Which catches your eye?';return 'Got it. Let’s work through that together. What would a good result look like to you?'}
function sendMessage(text){
 text=text.trim();if(!text)return;
 const a=active(),id=a.id;a.lastContactAt=Date.now();data.messages[id]??=[];
 data.messages[id].push({id:crypto.randomUUID(),role:'user',text,time:timeNow(),at:Date.now()});drafts[id]='';
 if(pending.has(id))clearTimeout(pending.get(id));
 const timer=setTimeout(()=>{
  pending.delete(id);const away=screen!=='chat'||activeId!==id;
  data.messages[id].push({id:crypto.randomUUID(),role:'agent',text:replyFor(text),time:timeNow(),at:Date.now(),notify:away,unread:away});
  if(away)a.unread=true;save();if(screen!=='login')render();
 },1100);
 pending.set(id,timer);save();render();document.getElementById('message-input')?.focus();
}
// Provider definitions are separate from the selected connection. Only ChatGPT is offered for now.
function modelProviders(){return [{id:'chatgpt',name:'ChatGPT',description:'Use your ChatGPT plan for eligible AI requests.'}]}
function connectedProvider(){return modelProviders().find(provider=>provider.id===data.demoProvider)||null}
function providerMark(provider){return provider?.id==='chatgpt'?'<span class="chatgpt-mark" aria-hidden="true"></span>':icon('plug')}
function providerLabel(provider){return provider?`${provider.name}: connected — model provider settings`:'Model provider: not connected — connection settings'}
function providerButton(){
 const provider=connectedProvider(),label=providerLabel(provider);
 return `<button class="icon-button provider-connection" data-provider data-connected="${!!provider}" aria-label="${label}" title="${label}" aria-haspopup="dialog">${providerMark(provider)}</button>`;
}
function syncProviderButtons(){
 const provider=connectedProvider(),label=providerLabel(provider);
 root.querySelectorAll('[data-provider]').forEach(button=>{
  button.dataset.connected=String(!!provider);
  button.setAttribute('aria-label',label);
  button.title=label;
  button.innerHTML=providerMark(provider);
 });
}
function providerCard(provider){
 const connected=connectedProvider()?.id===provider.id;
 return `<li class="provider-option"><div class="provider-card"><div class="provider-card-heading">${providerMark(provider)}<div><strong>${provider.name}</strong>${connected?'<span class="chatgpt-state" data-connected="true">Connected · Preview</span>':'<span class="provider-description">ChatGPT plan</span>'}</div></div>
  <p class="provider-card-copy">${provider.description}</p></div>
  ${connected?`<div class="chatgpt-manage"><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage ${icon('external')}<span class="sr-only">(opens ChatGPT in a new tab)</span></a><button class="button light" data-provider-disconnect>Disconnect</button></div>`:
   '<div class="chatgpt-action"><button class="chatgpt-signin" data-provider-connect="chatgpt" aria-describedby="provider-preview-note"><span class="chatgpt-signin-logo" aria-hidden="true"></span><span>Continue with ChatGPT</span></button></div>'}
 </li>`;
}
function providerDialog(){
 const provider=connectedProvider();
 openModal(`${head(provider?'Model providers.':'Power your agents.')}<p class="dialog-copy">${provider?'Manage the account powering your agents.':'Your agents need a model to work with. Connect a provider to get started.'}</p>
  <ul class="provider-list" aria-label="Available model providers">${modelProviders().map(providerCard).join('')}</ul>
  <p class="provider-availability">ChatGPT is the only provider available for now.</p>
  <p class="prototype-notice chatgpt-preview-note" id="provider-preview-note"><strong>Design preview.</strong> ${provider?'This is a simulated connection. Your ChatGPT account has not been linked.':'Connecting previews the connected state. In the app, you’ll sign in with your chosen provider.'}</p>`);
 dialog.querySelectorAll('[data-provider-connect]').forEach(button=>button.addEventListener('click',()=>{
  // UI prototype only: never request, collect, or store OAuth credentials here.
  const selected=modelProviders().find(item=>item.id===button.dataset.providerConnect);
  if(!selected)return;
  data.demoProvider=selected.id;save();syncProviderButtons();
  providerDialog();
  toast(`${selected.name} connection preview enabled.`);
 }));
 dialog.querySelector('[data-provider-disconnect]')?.addEventListener('click',()=>{
  data.demoProvider=null;save();syncProviderButtons();
  providerDialog();
  toast('Model provider disconnected in the preview.');
 });
 // Keep focus in the dialog without rerendering the chat or artifact pane.
 dialog.querySelector(provider?'[data-close]':'[data-provider-connect]').focus();
}
function openModal(content){dialog.innerHTML=content;dialog.showModal();EverythingMotion.enter(dialog);dialog.querySelector('[data-close]')?.addEventListener('click',()=>dialog.close());dialog.querySelector('[data-cancel]')?.addEventListener('click',()=>dialog.close())}
function head(title){return `<div class="dialog-head"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-close aria-label="Close dialog">${icon('close')}</button></div>`}
function agentEditor(id){const a=id?data.agents.find(x=>x.id===id):null;openModal(`${head(a?'Make it yours.':'Someone new.')}<p class="dialog-copy">Choose a name for your agent. You can change it whenever you like.</p><form id="agent-form"><label class="field">Agent name<input id="agent-name" value="${esc(a?.name||'')}" placeholder="A name that feels right" maxlength="32" required autofocus></label><label class="field">A little about them <span class="muted">(optional)</span><input id="agent-role" value="${esc(a?.role||'')}" placeholder="What will you work on together?" maxlength="70"></label><div class="dialog-actions"><button class="button light" type="button" data-cancel>Cancel</button><button class="button primary" type="submit">${a?'Save changes':'Create agent'}</button></div></form>`);document.getElementById('agent-form').addEventListener('submit',e=>{e.preventDefault();const name=document.getElementById('agent-name').value.trim();if(!name){document.getElementById('agent-name').focus();return}const role=document.getElementById('agent-role').value.trim()||'Your everyday collaborator';if(a){a.name=name;a.role=role}else{const id=crypto.randomUUID();data.agents.push({id,name,role,color:['','purple','blue'][data.agents.length%3],unread:false});data.messages[id]=[{id:crypto.randomUUID(),role:'agent',text:'Hi. What would you like to work on together?',time:timeNow(),at:Date.now()}]}save();dialog.close();render();toast(a?'Agent updated.':'Your new agent is ready.');});document.getElementById('agent-name').focus()}
function notifications(){openModal(`${head('Stay in the loop.')}<p class="dialog-copy">Hear from your agents, even when you’re away from Everything.</p><div class="steps"><div><span class="step-number">1</span><span>On iPhone, open Everything in Safari. Tap Share, then <strong>Add to Home Screen</strong>.</span></div><div><span class="step-number">2</span><span>Open Everything from your Home Screen and choose <strong>Enable notifications</strong>.</span></div><div><span class="step-number">3</span><span>Allow notifications when your phone asks. You’re all set.</span></div></div><div class="prototype-notice">Design preview: this button simulates the enabled state. It does not request permission or send real notifications.</div><div class="dialog-actions"><button class="button light" data-cancel>Maybe later</button><button class="button primary" id="enable-notifications">${data.notifications?'Turn off in demo':'Enable in demo'}</button></div>`);document.getElementById('enable-notifications').addEventListener('click',()=>{data.notifications=!data.notifications;save();dialog.close();render();toast(data.notifications?'Demo notifications enabled.':'Demo notifications turned off.')})}
function bind(){root.querySelectorAll('[data-provider]').forEach(b=>b.addEventListener('click',providerDialog));root.querySelectorAll('[data-nav]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.nav)));root.querySelectorAll('[data-update]').forEach(b=>b.addEventListener('click',()=>openUpdate(b.dataset.update)));root.querySelectorAll('[data-agent]').forEach(b=>b.addEventListener('click',()=>openAgent(b.dataset.agent)));root.querySelectorAll('[data-create]').forEach(b=>b.addEventListener('click',()=>agentEditor()));root.querySelectorAll('[data-rename]').forEach(b=>b.addEventListener('click',()=>agentEditor(b.dataset.rename)));root.querySelectorAll('[data-artifact]').forEach(b=>b.addEventListener('click',artifact));root.querySelectorAll('[data-notifications]').forEach(b=>b.addEventListener('click',notifications));root.querySelectorAll('[data-panel]').forEach(b=>b.addEventListener('click',()=>{closeArtifact(true);panel=!panel;render()}));root.querySelectorAll('[data-suggest]').forEach(b=>b.addEventListener('click',()=>sendMessage(b.dataset.suggest)));document.getElementById('sign-in')?.addEventListener('submit',e=>{e.preventDefault();navigate('dashboard')});document.getElementById('search')?.addEventListener('input',e=>{document.getElementById('agents-grid').innerHTML=cards(e.target.value);const grid=document.getElementById('agents-grid');grid.querySelectorAll('[data-agent]').forEach(b=>b.addEventListener('click',()=>openAgent(b.dataset.agent)));grid.querySelectorAll('[data-rename]').forEach(b=>b.addEventListener('click',()=>agentEditor(b.dataset.rename)));grid.querySelectorAll('[data-create]').forEach(b=>b.addEventListener('click',()=>agentEditor()))});document.getElementById('composer')?.addEventListener('submit',e=>{e.preventDefault();sendMessage(document.getElementById('message-input').value)});const input=document.getElementById('message-input');if(input){input.addEventListener('input',()=>{drafts[activeId]=input.value;document.querySelector('.send').disabled=!input.value.trim();input.style.height='auto';input.style.height=Math.min(input.scrollHeight,120)+'px'});input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendMessage(input.value)}})}}
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close()}});
window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==window.parent)return;if(e.data.type==='navigate'&&['login','dashboard','agents','chat'].includes(e.data.screen))navigate(e.data.screen);if(e.data.type==='reset'){for(const timer of pending.values())clearTimeout(timer);pending.clear();data=initialData();activeId=data.agents[0].id;chatReturn='dashboard';drafts={};panel=false;save();navigate('login');toast('Demo reset.')}});
render();
