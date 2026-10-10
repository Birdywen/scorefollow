const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  console.log('访问应用...');
  const navStart = Date.now();
  await page.goto('http://localhost:3000/scorefollow/');
  await page.waitForSelector('header', { timeout: 10000 });
  console.log(`页面加载: ${Date.now() - navStart}ms`);
  
  console.log('\n点击菜单并上传 PDF...');
  await page.click('button:has-text("打开")');
  await page.click('button:has-text("载入 PDF 谱")');
  
  const fileInput = await page.locator('input[type="file"][accept*="pdf"]');
  const uploadStart = Date.now();
  await fileInput.setInputFiles('/home/user/scorefollow/public/chopin.pdf');
  console.log(`文件注入: ${Date.now() - uploadStart}ms`);
  
  console.log('\n等待小节识别完成...');
  const recognitionStart = Date.now();
  
  await page.waitForFunction(() => {
    const nav = document.querySelector('nav');
    if (!nav) return false;
    const txt = nav.textContent || '';
    return /小节|measures|systems|行/.test(txt) && !/等待谱面/.test(txt);
  }, { timeout: 60000 });
  
  const recognitionTime = Date.now() - recognitionStart;
  console.log(`小节识别: ${recognitionTime}ms (${(recognitionTime/1000).toFixed(1)}秒)`);
  
  const canvasCount = await page.locator('#notation canvas').count();
  console.log(`\n谱面 canvas 数量: ${canvasCount}`);
  console.log(`总耗时: ${Date.now() - navStart}ms (${((Date.now() - navStart)/1000).toFixed(1)}秒)`);
  
  await browser.close();
})();
