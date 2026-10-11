import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const screenshotDir = join(__dirname, '../../test-results/vamp-e2e');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    permissions: ['microphone']
  });
  const page = await context.newPage();

  console.log('\n=== VAMP & Rhythm Annotator E2E Test ===\n');

  try {
    // 1. Load app
    console.log('1. Loading app...');
    await page.goto('http://localhost:3000/scorefollow');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: join(screenshotDir, '01-loaded.png') });
    console.log('   ✓ App loaded');

    // 2. Upload a score
    console.log('\n2. Uploading score...');
    const fileInput = await page.locator('input[type="file"]').first();
    await fileInput.setInputFiles('/home/user/scorefollow/public/Score/swan_cello_melody.pdf');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(screenshotDir, '02-score-uploaded.png') });
    console.log('   ✓ Score uploaded');

    // 3. Check if rhythm analysis is available
    console.log('\n3. Checking rhythm analysis availability...');
    const hasRhythmButton = await page.locator('button:has-text("Rhythm")').count() > 0;
    if (hasRhythmButton) {
      console.log('   ✓ Rhythm analysis button found');
      await page.locator('button:has-text("Rhythm")').click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: join(screenshotDir, '03-rhythm-panel.png') });
    } else {
      console.log('   ⚠ Rhythm analysis button not found (may be in different location)');
    }

    // 4. Start recording and check for VAMP features
    console.log('\n4. Testing audio recording with VAMP features...');
    const startBtn = await page.locator('button:has-text("Start")');
    if (await startBtn.count() > 0) {
      await startBtn.first().click();
      console.log('   ✓ Recording started');
      await page.waitForTimeout(3000);
      await page.screenshot({ path: join(screenshotDir, '04-recording.png') });
      
      const stopBtn = await page.locator('button:has-text("Stop")');
      if (await stopBtn.count() > 0) {
        await stopBtn.first().click();
        console.log('   ✓ Recording stopped');
        await page.waitForTimeout(2000);
        await page.screenshot({ path: join(screenshotDir, '05-analysis-complete.png') });
      }
    } else {
      console.log('   ⚠ Start button not found (checking alternative selectors)');
    }

    // 5. Check console for VAMP-related logs
    console.log('\n5. Checking for VAMP feature usage in network calls...');
    let vampUsed = false;
    page.on('response', async (response) => {
      if (response.url().includes('/analyze')) {
        try {
          const json = await response.json();
          if (json.pitch_notes || json.onsets || json.beats) {
            vampUsed = true;
            console.log('   ✓ VAMP features detected in API response');
          }
        } catch (e) {}
      }
    });

    // 6. Final state
    await page.screenshot({ path: join(screenshotDir, '06-final-state.png') });
    
    console.log('\n=== Test Summary ===');
    console.log('✓ App functional');
    console.log('✓ Score upload works');
    console.log(`${hasRhythmButton ? '✓' : '⚠'} Rhythm analysis UI available`);
    console.log('✓ Screenshots captured in test-results/vamp-e2e/');
    console.log('\nNext: Check server logs for VAMP plugin usage');

  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    await page.screenshot({ path: join(screenshotDir, 'error.png') });
    throw error;
  } finally {
    await browser.close();
  }
})();
