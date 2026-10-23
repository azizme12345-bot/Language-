// app-extras.js
// Runs in the browser. It replaces the Mic, Camera/Image and Translate behaviour
// of the translator page so that:
//   - Mic records your voice and turns it into text through /api/transcribe
//   - Camera / Image lets you pick a photo, then /api/image translates or analyzes it
//   - Translate sends text to /api/translate, or the photo to /api/image
//
// Load it once in index.html, after the existing <script> block:
//   <script src="/app-extras.js"></script>

(function () {
  const $ = (id) => document.getElementById(id);

  let pendingImage = null; // data URL of the chosen photo
  let recorder = null;
  let stream = null;
  let chunks = [];

  function readAsDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read the file.'));
      reader.readAsDataURL(blob);
    });
  }

  async function postJSON(url, payload) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      data = {};
    }
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  // ---------- MIC: speech to text ----------
  $('mic').onclick = async () => {
    // Second press stops the recording
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      return;
    }

    if (!navigator.mediaDevices || !window.MediaRecorder) {
      $('status').textContent = 'Voice recording is not supported in this browser.';
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      $('status').textContent = 'Microphone permission was denied.';
      return;
    }

    chunks = [];
    recorder = MediaRecorder.isTypeSupported('audio/webm')
      ? new MediaRecorder(stream, { mimeType: 'audio/webm' })
      : new MediaRecorder(stream);

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      $('mic').style.outline = '';

      const baseType = (recorder.mimeType || 'audio/webm').split(';')[0];
      const blob = new Blob(chunks, { type: baseType });
      if (!blob.size) {
        $('status').textContent = 'No audio was recorded.';
        return;
      }

      $('status').textContent = 'Converting your speech to text…';
      try {
        const audio = await readAsDataURL(blob);
        const data = await postJSON('/api/transcribe', {
          audio,
          language: $('from').value,
        });
        const current = $('source').value.trim();
        $('source').value = current ? current + ' ' + data.text : data.text;
        $('status').textContent = 'Speech converted to text.';
      } catch (err) {
        $('status').textContent = err.message;
      }
    };

    recorder.start();
    $('mic').style.outline = '2px solid #168f70';
    $('status').textContent = 'Listening… press Mic again to stop.';
  };

  // ---------- IMAGE: choose a photo ----------
  async function useImageFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      $('status').textContent = 'Image is too large. Please choose one under 5 MB.';
      return;
    }
    try {
      pendingImage = await readAsDataURL(file);
      $('status').textContent = 'Image selected: ' + file.name + '. Press "Translate / Analyze".';
    } catch (err) {
      $('status').textContent = err.message;
    }
  }

  $('imageFile').onchange = (e) => useImageFile(e.target.files[0]);

  $('anyFile').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.type.startsWith('image/')) {
      useImageFile(file);
    } else if (file.type.startsWith('text/')) {
      const reader = new FileReader();
      reader.onload = () => {
        $('source').value = reader.result;
      };
      reader.readAsText(file);
    } else {
      $('status').textContent = 'Please choose an image or a text file.';
    }
  };

  // ---------- TRANSLATE: text or image ----------
  $('translate').onclick = async () => {
    const btn = $('translate');
    const text = $('source').value.trim();

    if (!pendingImage && !text) {
      $('status').textContent = 'Please type, speak, or choose an image first.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Working…';
    $('status').textContent = '';

    try {
      let data;
      if (pendingImage) {
        data = await postJSON('/api/image', {
          image: pendingImage,
          from: $('from').value,
          to: $('to').value,
          mode: 'analyze',
          text,
        });
        pendingImage = null;
      } else {
        data = await postJSON('/api/translate', {
          text,
          from: $('from').value,
          to: $('to').value,
        });
      }
      $('result').textContent = data.translation;
      $('status').textContent = 'Done.';
    } catch (err) {
      $('status').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Translate / Analyze';
    }
  };

  // ---------- CLEAR also forgets the chosen photo ----------
  const oldClear = $('clear').onclick;
  $('clear').onclick = (e) => {
    pendingImage = null;
    if (oldClear) oldClear(e);
  };
})();
