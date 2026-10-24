// This standards-based DOM view assigns refs to real Elements (including the
// parents of visible text nodes). Playwright's public locators execute actions.
// Output follows document order under named structural containers (dialogs,
// forms, table rows, lists, groups), so a field sits beside its label and a
// row action beside its row. Over budget, controls and the text sharing their
// container are kept before other text.
export function browserSemanticSnapshotExpression(nonce: string, query?: { text?: string; regex?: string }): string {
  return `(() => {
    const nonce=${JSON.stringify(nonce)}, query=${JSON.stringify(query ?? {})};
    // The map lives in the page's main world, where frame.evaluateHandle can
    // retrieve the exact original node. It is replaced on every observation.
    const refs=new Map();
    Object.defineProperty(globalThis,Symbol.for('memmy.playwright.element.refs'),
      {value:refs,writable:true,configurable:true});
    let scanned=0,truncated=false;
    const raw=query.regex||'', match=/^\\/(.*)\\/([imsu]*)$/.exec(raw);
    const pattern=raw?(match?new RegExp(match[1],match[2]):new RegExp(raw)):null;
    const filtering=!!(pattern||query.text);
    const matches=value => pattern?pattern.test(value):!query.text||value.toLowerCase().includes(query.text.toLowerCase());
    const style=el => getComputedStyle(el);
    const visible=el => !!el.getClientRects().length && style(el).visibility!=='hidden';
    const clean=value => String(value||'').slice(0,4000).replace(/\\s+/g,' ').trim().slice(0,1000);
    const explicitRole=el => { const value=el.getAttribute('role'); return value&&!/^(presentation|none|generic)$/.test(value)?value:''; };
    // Contenteditable is inherited. Only an editing host is a field; its nested
    // paragraphs and spans remain content, including inside plaintext-only hosts.
    const editingHost=el => el.isContentEditable&&!el.parentElement?.isContentEditable;
    const labelledBy=el => (el.getAttribute('aria-labelledby')||'').split(/\\s+/).filter(Boolean)
      .map(id=>el.getRootNode().getElementById?.(id)?.textContent||'').join(' ').trim();
    const role=el => explicitRole(el) || ({BUTTON:'button',SELECT:'combobox',TEXTAREA:'textbox',A:el.hasAttribute('href')?'link':'',SUMMARY:'button'}[el.tagName]) || (el.tagName==='INPUT' ? ({checkbox:'checkbox',radio:'radio',button:'button',submit:'button',range:'slider',number:'spinbutton',search:'searchbox'}[el.type]||'textbox') : editingHost(el)?'textbox':/^H[1-6]$/.test(el.tagName)?'heading':'');
    const name=el => clean(el.getAttribute('aria-label') || labelledBy(el) || Array.from(el.labels||[]).map(label=>label.innerText).join(' ') || el.getAttribute('alt') || (['INPUT','TEXTAREA'].includes(el.tagName)||editingHost(el)?el.getAttribute('aria-placeholder')||el.getAttribute('placeholder'):el.innerText) || el.getAttribute('title'));
    // Empty editors commonly contain a starter <p><br></p>. Keep that empty,
    // while preserving meaningful whitespace and line breaks in entered values.
    const valueOf=el => {
      if(el.tagName==='INPUT'&&el.type==='password')return '';
      const value=editingHost(el)?(el.textContent?el.innerText:''):(el.value||'');
      return String(value??'').slice(0,1000);
    };
    const INTERACTIVE=/^(button|link|textbox|searchbox|combobox|checkbox|radio|switch|slider|spinbutton|tab|menuitem|menuitemcheckbox|menuitemradio|option|treeitem)$/;
    const CONTAINER=/^(dialog|alertdialog|form|table|grid|treegrid|row|list|listbox|menu|menubar|tablist|tabpanel|tree|group|radiogroup|region|navigation|main|complementary|search|toolbar)$/;
    const containerRole=el => {
      const value=explicitRole(el);
      if(value)return CONTAINER.test(value)?value:'';
      if(editingHost(el))return '';
      if(el.tagName==='FORM')return 'form';
      if(el.tagName==='SECTION')return el.hasAttribute('aria-label')||el.hasAttribute('aria-labelledby')?'region':'';
      return ({DIALOG:'dialog',TABLE:'table',TR:'row',UL:'list',OL:'list',FIELDSET:'group',NAV:'navigation',MAIN:'main',ASIDE:'complementary'})[el.tagName]||'';
    };
    const textOf=(el,limit) => {
      if(!el)return '';
      const walker=document.createTreeWalker(el,4); let text='',node,count=0;
      while((node=walker.nextNode())&&text.length<limit&&count++<200) {
        if(!/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.parentElement?.tagName||''))text+=' '+node.nodeValue;
      }
      return clean(text).slice(0,limit);
    };
    const containerName=(el,r) => {
      const own=clean(el.getAttribute('aria-label')||labelledBy(el)).slice(0,160);
      if(own)return own;
      if(el.tagName==='FIELDSET')return textOf(el.querySelector(':scope>legend'),120);
      if(r==='dialog'||r==='alertdialog')return textOf(el.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]'),120);
      if(r==='row')return [...el.children].slice(0,4).map(cell=>textOf(cell,60)).filter(Boolean).join(' | ').slice(0,160);
      if(el.tagName==='TABLE')return textOf(el.querySelector(':scope>caption'),120);
      return '';
    };
    const stateOf=el => {
      const state={};
      for(const [attribute,key] of [['aria-checked','checked'],['aria-expanded','expanded'],['aria-selected','selected'],['aria-disabled','disabled']]) {
        if(el.hasAttribute(attribute))state[key]=el.getAttribute(attribute)==='true'?true:el.getAttribute(attribute)==='false'?false:el.getAttribute(attribute);
      }
      if(['checkbox','radio'].includes(el.type))state.checked=el.checked;
      if('disabled' in el)state.disabled=el.disabled;
      if('readOnly' in el)state.readOnly=el.readOnly;
      if(el.tagName==='INPUT'&&el.type==='password')state.valueRedacted=true;
      if(editingHost(el))state.editable=true;
      if(el.hasAttribute('aria-multiline'))state.multiline=el.getAttribute('aria-multiline')==='true';
      else if(editingHost(el)||el.tagName==='TEXTAREA')state.multiline=true;
      if(el.tagName==='SELECT') {
        const options=Array.from(el.options), filtered=options.filter(option=>matches(clean(option.text)+' '+option.value));
        state.options=filtered.slice(0,25).map(option=>({label:clean(option.text).slice(0,200),value:String(option.value).slice(0,200),selected:option.selected,disabled:option.disabled}));
        if(filtered.length>25)state.optionsTruncated=true;
      }
      return state;
    };
    const entries=[], seen=new Set(), stack=[];
    const add=(el,r,n,depth,text) => {
      if(entries.length>=5000){truncated=true;return;}
      if((!text&&seen.has(el))||!visible(el)||el.closest('[aria-hidden="true"]'))return;
      if(!text)seen.add(el);
      const state=text?{}:stateOf(el);
      // Pages often build buttons from styled text; the pointer cursor says it acts.
      if((text||!INTERACTIVE.test(r))&&style(el).cursor==='pointer')state.clickable=true;
      const node={role:r||'text',name:clean(n),value:text?'':valueOf(el),
        ...(Object.keys(state).length?{state}:{})};
      if(filtering&&!matches(node.role+' '+node.name+' '+node.value+' '+JSON.stringify(state)))return;
      entries.push({node,el,depth,control:INTERACTIVE.test(node.role),owner:stack.at(-1),
        ...(filtering?{context:stack.map(container=>container.label).join(' > ').slice(0,240)}:{})});
    };
    const walk=(root,depth) => {
      for(const child of root.childNodes) {
        if(++scanned>30000){truncated=true;return;}
        if(child.nodeType===1) {
          if(/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|IFRAME|FRAME)$/.test(child.tagName)||child.getAttribute('aria-hidden')==='true')continue;
          const containerKind=containerRole(child);
          let inner=depth, container=null;
          if(containerKind&&visible(child)) {
            const containerLabel=containerName(child,containerKind);
            container={container:true,role:containerKind,name:containerLabel,depth,start:entries.length,end:entries.length,
              label:containerKind+(containerLabel?' "'+containerLabel+'"':''),
              modal:/dialog/.test(containerKind)&&(child.getAttribute('aria-modal')==='true'||child.matches(':modal'))};
            entries.push(container); stack.push(container); inner=depth+1;
          } else if(!containerKind) {
            const r=role(child); if(r)add(child,r,name(child),depth);
          }
          if(child.shadowRoot)walk(child.shadowRoot,inner);
          walk(child,inner);
          if(container){stack.pop(); container.end=entries.length;}
        } else if(child.nodeType===3&&child.textContent.trim()) {
          const parent=child.parentElement,el=parent?.tagName==='LABEL'&&parent.control?parent.control:parent;
          if(!el)continue;
          // Text directly inside a container is kept as text; the container itself is not a node.
          if(containerRole(el))add(el,'text',child.textContent,depth,child.textContent);
          else add(el,role(el)||'text',role(el)?name(el):el.innerText||child.textContent,depth);
        }
      }
    };
    walk(document.body||document.documentElement,0);
    // A page longer than the scan still offers its remaining controls.
    if(scanned>30000)for(const el of document.querySelectorAll('button,a[href],input,select,textarea,summary,[role],[contenteditable]')) {
      if(entries.length>=5000)break;
      const r=role(el); if(INTERACTIVE.test(r))add(el,r,name(el),0);
    }
    const leaves=entries.filter(entry=>!entry.container);
    const actionable=new Set(leaves.filter(entry=>entry.control).map(entry=>entry.owner));
    let count=0,characters=0;
    for(const level of [0,1,2])for(const entry of leaves) {
      if((entry.control?0:actionable.has(entry.owner)?1:2)!==level)continue;
      const size=JSON.stringify(entry.node).length+24;
      if(count>=600||characters+size>40000){truncated=true;continue;}
      entry.keep=true; count++; characters+=size;
    }
    const nodes=[]; let next=0;
    for(const [index,entry] of entries.entries()) {
      if(entry.container) {
        if(filtering||!entries.slice(index+1,entry.end).some(inner=>inner.keep))continue;
        nodes.push({ref:'',role:entry.role,name:entry.name,value:'',depth:entry.depth,...(entry.modal?{state:{modal:true}}:{})});
        continue;
      }
      if(!entry.keep)continue;
      const ref='pw-'+nonce+'-'+(next++);
      refs.set(ref,new WeakRef(entry.el));
      nodes.push({ref,...entry.node,...(filtering?(entry.context?{context:entry.context}:{}):{depth:entry.depth})});
    }
    return {nodes,timeOrigin:performance.timeOrigin,url:location.href,truncated};
  })()`;
}
