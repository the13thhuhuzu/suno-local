chrome.action.onClicked.addListener(tab => {
  const onSuno = /^https:\/\/(?:www\.)?suno\.com\//.test(tab.url || '');
  chrome.tabs.create({ url: chrome.runtime.getURL('connect.html') + (onSuno ? '#' + tab.id : '') });
});
