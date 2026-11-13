// ProtankiClientRemake ChatTab / ChatOutput / ChatOutputLine, public lobby channel.
import {ServerError,type Connection} from '../../net2/Connection.ts';
import type {LobbyChatMessage} from '../../net2/protocol.ts';
import {errorText} from '../../net2/S2Client.ts';
import {TankWindow,WindowInner,DefaultButton,HEADER,INNER,el,place} from './widgets.ts';
import {MIN_FLASH_WIDTH,MIN_FLASH_HEIGHT,HEADER_HEIGHT} from './BattleSelectView.ts';
import './lobby-chat.css';

export class LobbyChat {
 private readonly window:TankWindow;
 private readonly inner:WindowInner;
 private readonly log:HTMLDivElement;
 private readonly input:HTMLInputElement;
 private readonly inputFrame:HTMLDivElement;
 private readonly button:DefaultButton;
 private readonly error:HTMLDivElement;
 private readonly newsButton:DefaultButton;
 private readonly chatButton:DefaultButton;
 private readonly newsEmpty:HTMLDivElement;
 private tab:'news'|'chat'='chat';
 private connection:Connection|null=null;
 private off:(()=>void)|null=null;
 private active=false;
 private pending=false;
 private generation=0;
 private readonly messages=new Map<number,LobbyChatMessage>();
 constructor(parent:HTMLElement){
  this.window=new TankWindow(parent,HEADER.CHAT);this.window.root.classList.add('lobby-chat');
  this.newsButton=new DefaultButton(this.window.root,'Новости');this.chatButton=new DefaultButton(this.window.root,'Чат');
  for(const [name,button] of [['news',this.newsButton],['chat',this.chatButton]] as const){
    button.root.classList.add('lobby-chat-tab');const icon=el('img','lobby-chat-tab-icon',button.root);icon.src=`/battle/lobby_chat/${name}.png`;icon.alt='';button.onClick=()=>this.selectTab(name);
  }
  this.inner=new WindowInner(this.window.root,INNER.GREEN,true);this.inner.root.classList.add('lobby-chat-history');
  this.log=el('div','lobby-chat-log',this.inner.root);this.log.setAttribute('role','log');this.log.setAttribute('aria-label','Общий чат');
  this.newsEmpty=el('div','lobby-chat-news-empty',this.inner.root);this.newsEmpty.textContent='Новостей пока нет';
  this.inputFrame=el('div','lb-abs lobby-chat-input-frame',this.window.root);
  for(const side of ['left','center','right'])el('div',`lobby-chat-input-${side}`,this.inputFrame);
  this.input=el('input','lobby-chat-input',this.inputFrame);this.input.type='text';this.input.maxLength=299;this.input.placeholder='';this.input.setAttribute('aria-label','Сообщение в общий чат');
  this.button=new DefaultButton(this.window.root,'Отправить');this.button.onClick=()=>void this.send();
  this.error=el('div','lobby-chat-error',this.window.root);this.error.setAttribute('role','status');
  this.input.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Enter'&&!event.isComposing){event.preventDefault();void this.send();}else if(event.key==='Escape')this.input.blur();});
  this.input.addEventListener('keyup',event=>event.stopPropagation());
  this.window.root.hidden=true;window.addEventListener('resize',this.layout);this.layout();this.selectTab('chat');
 }
 connect(connection:Connection):void {
  if(this.connection===connection)return;
  if(this.connection&&this.active)void this.connection.request('lobby.chatUnwatch',{}).catch(()=>{});
  this.off?.();this.connection=connection;this.generation++;this.pending=false;this.button.setEnabled(true);this.messages.clear();this.log.replaceChildren();this.error.textContent='';this.input.value='';
  this.off=connection.on('lobby.chat',({message})=>this.receive([message]));
  if(this.active)this.watch();
 }
 set visible(value:boolean){
  this.window.root.hidden=!value;if(this.active===value)return;this.active=value;this.generation++;
  if(value){this.layout();this.watch();}else {this.input.blur();if(this.connection)void this.connection.request('lobby.chatUnwatch',{}).catch(()=>{});}
 }
 private selectTab(tab:'news'|'chat'):void {
  this.tab=tab;this.newsButton.root.classList.toggle('is-active',tab==='news');this.chatButton.root.classList.toggle('is-active',tab==='chat');
  this.newsEmpty.hidden=tab!=='news';this.log.hidden=tab!=='chat';this.inputFrame.hidden=this.button.root.hidden=tab!=='chat';this.error.hidden=tab!=='chat';
  if(tab==='news')this.input.blur();
 }
 private watch():void {
  const generation=this.generation;this.error.textContent='';
  void this.connection?.request('lobby.chatWatch',{}).then(({messages})=>{if(this.active&&this.generation===generation)this.receive(messages);}).catch(e=>{if(this.active&&this.generation===generation)this.error.textContent=errorText(e);});
 }
 private receive(messages:LobbyChatMessage[]):void {
  const scrollTop=this.log.scrollTop;
  const bottom=this.log.scrollHeight-this.log.scrollTop-this.log.clientHeight<24;
  for(const m of messages)this.messages.set(m.messageId,m);
  const sorted=[...this.messages.values()].sort((a,b)=>a.messageId-b.messageId).slice(-80);this.messages.clear();this.log.replaceChildren();
  for(const m of sorted){
   this.messages.set(m.messageId,m);const row=el('div','lobby-chat-line',this.log);
   const user=(author:string,rankValue:number,suffix:string)=>{
     const button=el('button','lobby-chat-user',row);button.type='button';button.title=`Ответить ${author}`;
     const rank=el('img','lobby-chat-rank',button);rank.src=`/battle/hud/rank_small/${Math.max(1,Math.min(30,rankValue))}.png`;rank.alt='';rank.draggable=false;
     const name=el('span','',button);name.textContent=author+suffix;
     button.addEventListener('click',()=>{this.input.value=`${author}: `;this.input.focus();});
   };
   user(m.author,m.rank,m.recipient?'':':');
   if(m.recipient){const dash=el('span','lobby-chat-address',row);dash.textContent=' — ';user(m.recipient.author,m.recipient.rank,':');}
   const text=el('span','lobby-chat-text',row);text.textContent=` ${m.text}`;
  }
  this.log.scrollTop=bottom?this.log.scrollHeight:scrollTop;
 }
 private async send():Promise<void>{
  const text=this.input.value.trim(),connection=this.connection;if(!text||!connection||this.pending||!this.active||this.tab!=='chat')return;
  const generation=this.generation;this.pending=true;this.button.setEnabled(false);this.error.textContent='';
  try{await connection.request('lobby.chatSend',{text});if(this.generation===generation&&this.input.value.trim()===text)this.input.value='';}
  catch(error){if(this.generation===generation)this.error.textContent=error instanceof ServerError&&error.code==='rate_limited'?'Подожди секунду перед следующим сообщением':errorText(error);}
  finally{this.pending=false;this.button.setEnabled(true);}
 }
 readonly layout=():void=>{
  const width=Math.trunc(Math.max(MIN_FLASH_WIDTH,window.innerWidth)/3),height=Math.max(window.innerHeight-HEADER_HEIGHT,MIN_FLASH_HEIGHT);
  this.window.setBounds(0,HEADER_HEIGHT,width,height);this.inner.setBounds(8,44,width-16,height-84);
  this.newsButton.setBounds(8,8,102);this.chatButton.setBounds(115,8,102);
  place(this.inputFrame,8,height-38,width-101,30);this.button.setBounds(width-88,height-38,80);place(this.error,13,height-58,width-26,16);
 };
}
