// SAFETY CHECKLIST
// Count checked boxes and update the progress bar on the safety page.
const checklist = Array.from(
  document.querySelectorAll("#prepare input[type='checkbox']")
);
const progressBar = document.querySelector("#checklist-progress");
const checklistCount = document.querySelector("#checklist-count");
const resetButton = document.querySelector("#reset-checklist");

if (checklist.length && progressBar && checklistCount && resetButton) {
  const progressTrack = progressBar.closest("[role='progressbar']");

  function updateChecklist() {
    const completed = checklist.filter((item) => item.checked).length;
    const percentage = Math.round((completed / checklist.length) * 100);

    progressBar.style.width = `${percentage}%`;
    progressTrack.setAttribute("aria-valuenow", percentage);
    checklistCount.textContent = `${completed} of ${checklist.length} ready`;
  }

  checklist.forEach((item) => item.addEventListener("change", updateChecklist));

  resetButton.addEventListener("click", () => {
    checklist.forEach((item) => {
      item.checked = false;
    });
    updateChecklist();
    checklist[0].focus();
  });
}

// WILDFIRE MAP
// Leaflet (L) controls the map. NASA files provide the fire locations.
// Canvas draws the dots efficiently because there are over 600,000 detections.
async function loadFireMapArchive(encodedChunks) {
  const days = {};
  let dataset = null;

  for (const encodedChunk of encodedChunks) {
    const compressedBytes = Uint8Array.from(atob(encodedChunk), character => character.charCodeAt(0));
    const decompressedStream = new Blob([compressedBytes])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    const chunk = await new Response(decompressedStream).json();
    Object.assign(days, chunk.days);
    if (chunk.dataset) dataset = chunk.dataset;
  }

  if (!dataset || !Array.isArray(dataset.dates) || Object.keys(days).length !== dataset.dates.length) {
    throw new Error('The archive data is incomplete.');
  }

  return {dataset, days};
}

const mapContainer = document.querySelector('#wildfire-map');
if (mapContainer) {
  void initializeFireMap(mapContainer);
}

async function initializeFireMap(mapContainer) {
  const form = document.querySelector('#map-filters');
  const period = document.querySelector('#map-period');
  const summary = document.querySelector('#filter-summary');
  const label = document.querySelector('#map-dataset-label');
  const archiveChunks = window.fireMapArchiveChunks;
  if (!window.L || !Array.isArray(archiveChunks) || typeof DecompressionStream !== 'function') {
    summary.textContent = 'The map could not load. Check your internet connection, browser support, and archive files, then reload.';
    label.textContent = 'Map unavailable';
  } else {
    let archive;
    try {
      archive = await loadFireMapArchive(archiveChunks);
    } catch (error) {
      console.error('Could not decode the wildfire archive.', error);
      summary.textContent = 'The wildfire archive could not be decoded. Check the archive files and reload the page.';
      label.textContent = 'Data loading failed';
      return;
    }
    const dataset = archive.dataset;
    window.fireMapDays = archive.days;
    window.fireMapDataset = dataset;

    // 1. Create the map and show Asia. No API key is needed.
    const asiaBounds = L.latLngBounds([[-11, 26], [82, 180]]);
    const map = L.map(mapContainer, {
      zoomAnimation: false,
      maxZoom: 18,
      maxBounds: asiaBounds,
      maxBoundsViscosity: 1 // Stop dragging beyond the Asia map area.
    });
    map.fitBounds(asiaBounds);

    // Keep the whole screen inside these limits, including after a resize.
    function limitMapToAsia() {
      map.setMinZoom(map.getBoundsZoom(asiaBounds, true));
      map.panInsideBounds(asiaBounds, {animate: false});
    }
    limitMapToAsia();
    map.on('resize', limitMapToAsia);

    // A simplified Asia outline hides Europe, Africa, and other continents.
    // The western edge follows the Urals, Caucasus, Turkey, and Suez area.
    const asiaOutline = [
      [82, 60], [82, 180], [50, 180], [30, 150], [5, 140],
      [-11, 141], [-11, 95], [5, 75], [5, 50], [12, 43],
      [30, 32.5], [36, 35.5], [36, 26], [42, 26], [42, 40],
      [43.5, 40], [43, 47], [47, 52], [51, 55], [55, 59],
      [60, 59], [65, 60], [68, 65], [72, 67], [77, 60]
    ];
    const worldOutline = [[-90, -360], [-90, 360], [90, 360], [90, -360]];
    map.createPane('outsideAsia');
    map.getPane('outsideAsia').style.zIndex = 450;
    map.getPane('outsideAsia').style.pointerEvents = 'none';
    L.polygon([worldOutline, asiaOutline], {
      pane: 'outsideAsia',
      stroke: false,
      fillColor: '#dce6e9',
      fillOpacity: 1,
      fillRule: 'evenodd',
      interactive: false
    }).addTo(map);

    // Only show detections inside the same Asia outline.
    function isInAsia(latitude, longitude) {
      let inside = false;
      for (let i = 0, j = asiaOutline.length - 1; i < asiaOutline.length; j = i++) {
        const [lat1, lon1] = asiaOutline[i];
        const [lat2, lon2] = asiaOutline[j];
        const crossesLatitude = (lat1 > latitude) !== (lat2 > latitude);
        const edgeLongitude = (lon2 - lon1) * (latitude - lat1) / (lat2 - lat1) + lon1;
        if (crossesLatitude && longitude < edgeLongitude) inside = !inside;
      }
      return inside;
    }
    // 2. OpenStreetMap supplies the background map images.
    const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, noWrap: true,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | NASA FIRMS'
    }).addTo(map);
    tiles.on('tileerror', () => {
      mapContainer.setAttribute('aria-description', 'Background tiles unavailable. Detection coordinates remain available.');
    });
    L.control.scale().addTo(map);
    // 3. Add a transparent drawing surface above the map for the fire dots.
    const canvas = L.DomUtil.create('canvas', 'fire-detection-canvas', map.getPane('overlayPane'));
    const context = canvas.getContext('2d');
    let detections = [];       // Fires in the selected date range.
    let visibleDots = [];      // Dots on screen, used when someone clicks.
    function drawFireDots() {
      const size = map.getSize();
      const ratio = window.devicePixelRatio || 1; // Keep dots sharp on high-resolution screens.
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
      canvas.width = size.x * ratio;
      canvas.height = size.y * ratio;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      visibleDots = [];
      const bounds = map.getBounds().pad(0.05);
      const radius = map.getZoom() < 6 ? 2 : 3.5;
      context.fillStyle = '#ff4b08'; // Red-orange center.
      context.strokeStyle = '#ffad32'; // Bright orange edge.
      context.lineWidth = 0.7;
      for (const fire of detections) {
        const location = [fire.latitude, fire.longitude];
        if (!bounds.contains(location)) continue; // Skip fires outside this view.

        // Turn the real latitude/longitude into a position on the screen.
        const point = map.latLngToContainerPoint(location);
        context.beginPath();
        context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        visibleDots.push({x: point.x, y: point.y, fire: fire});
      }
    }

    // Find the closest dot within 10 screen pixels of a click.
    function showNearestFire(clickPosition) {
      let nearestFire = null;
      let nearestDistance = 10;

      for (const dot of visibleDots) {
        const horizontalGap = clickPosition.x - dot.x;
        const verticalGap = clickPosition.y - dot.y;
        const distance = Math.sqrt(horizontalGap * horizontalGap + verticalGap * verticalGap);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestFire = dot.fire;
        }
      }

      if (nearestFire) showFireDetails(nearestFire);
    }

    // Put the selected fire's information into the existing details window.
    function showFireDetails(fire) {
      const confidenceNames = {h: 'High', n: 'Nominal', l: 'Low'};
      const confidence = confidenceNames[fire.confidence] || fire.confidence;
      const time = fire.time.slice(0, 2) + ':' + fire.time.slice(2);
      const dayOrNight = fire.daynight === 'D' ? 'Daytime' : 'Nighttime';

      document.querySelector('#map-dot-details-region').textContent =
        `NASA detection at ${fire.latitude}° latitude, ${fire.longitude}° longitude · ${fire.date}, ${time} UTC · ${dayOrNight}.`;
      document.querySelector('#map-dot-details-stats').textContent =
        `Satellite: ${fire.satellite} · Instrument (as supplied): ${fire.instrument} · Confidence: ${confidence} · ` +
        `Fire radiative power: ${fire.power} MW · Brightness: ${fire.brightness} K · ` +
        `Channel 31 brightness: ${fire.channel31} K · Scan × track: ${fire.scan} × ${fire.track} km · Product version: ${fire.version}.`;

      const detailsWindow = document.querySelector('#map-dot-details');
      bootstrap.Modal.getOrCreateInstance(detailsWindow).show();
    }

    // NASA rows are stored as compact lists to keep the files smaller.
    // Give each column a readable name before using it in the map.
    function readFire(row, date) {
      return {
        latitude: row[0],
        longitude: row[1],
        brightness: row[2],
        scan: row[3],
        track: row[4],
        time: row[5],
        satellite: row[6],
        instrument: row[7],
        confidence: row[8],
        version: row[9],
        channel31: row[10],
        power: row[11],
        daynight: row[12],
        date: date
      };
    }

    map.on('moveend resize', drawFireDots);
    map.on('click', event => showNearestFire(event.containerPoint));
    mapContainer.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        showNearestFire(map.getSize().divideBy(2)); // Inspect near the map's center.
      }
    });
    // 4. Read the chosen date range from the archive and redraw the dots.
    function applyDateFilter() {
      const numberOfDays = Number(period.value);
      const dates = dataset.dates.slice(-numberOfDays); // Take the latest 1, 7, or 30 days.
      summary.textContent = 'Loading original NASA detections…';
      label.textContent = 'Loading data…';
      try {
        detections = [];
        for (const date of dates) {
          for (const row of window.fireMapDays[date]) {
            if (isInAsia(row[0], row[1])) {
              detections.push(readFire(row, date));
            }
          }
        }
        drawFireDots();
        label.textContent = `${detections.length.toLocaleString()} detections`;
        summary.textContent = `Showing ${detections.length.toLocaleString()} Asia detections from ${dates[0]} to ${dates.at(-1)}. Pan and zoom to explore; click a red-orange dot for details.`;
      } catch (error) {
        summary.textContent = 'Could not load the selected archive. Check the fire detection files and reload the page. The previous selection remains on the map.';
        label.textContent = 'Data loading failed';
      }
    }
    // 5. Connect the form buttons and display the first selection.
    form.addEventListener('submit', event => {
      event.preventDefault(); // Keep the form from reloading the page.
      applyDateFilter();
    });
    form.addEventListener('reset', () => setTimeout(applyDateFilter, 0));
    applyDateFilter();
  }
}

// ACCOUNT DIALOGS
const accountTriggers = document.querySelectorAll("[data-account-action]");

if (accountTriggers.length) {
  const accountBackdrop = document.createElement("div");
  accountBackdrop.className = "account-dialog-backdrop";
  accountBackdrop.setAttribute("aria-hidden", "true");
  accountBackdrop.innerHTML = `
    <section class="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title">
      <div class="d-flex align-items-start justify-content-between gap-3 mb-3">
        <div>
          <p class="section-label text-uppercase fw-bold mb-1">PROJECT CRUSADERS</p>
          <h2 class="h3 fw-bold mb-0" id="account-dialog-title"></h2>
        </div>
        <button class="account-dialog-close" type="button" aria-label="Close dialog">&times;</button>
      </div>
      <form class="account-dialog-form">
        <div class="mb-3 account-name-field">
          <label class="form-label fw-semibold" for="account-name">Name</label>
          <input class="form-control" id="account-name" name="name" autocomplete="name" required>
        </div>
        <div class="mb-3">
          <label class="form-label fw-semibold" for="account-email">Email address</label>
          <input class="form-control" id="account-email" name="email" type="email" autocomplete="email" required>
        </div>
        <div class="mb-3">
          <label class="form-label fw-semibold" for="account-password">Password</label>
          <input class="form-control" id="account-password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <p class="small text-secondary mb-3">These demo forms are not connected to an authentication service.</p>
        <p class="account-dialog-status small fw-semibold mb-3" role="status" aria-live="polite"></p>
        <button class="btn btn-warning fw-bold w-100 account-dialog-submit" type="submit"></button>
      </form>
    </section>
  `;
  document.body.append(accountBackdrop);

  const accountTitle = accountBackdrop.querySelector("#account-dialog-title");
  const accountNameField = accountBackdrop.querySelector(".account-name-field");
  const accountPassword = accountBackdrop.querySelector("#account-password");
  const accountForm = accountBackdrop.querySelector(".account-dialog-form");
  const accountStatus = accountBackdrop.querySelector(".account-dialog-status");
  const accountSubmit = accountBackdrop.querySelector(".account-dialog-submit");
  const closeAccountDialog = accountBackdrop.querySelector(".account-dialog-close");
  let lastAccountTrigger = null;
  let accountAction = "login";

  function setAccountAction(action) {
    accountAction = action;
    const signingUp = action === "signup";
    accountTitle.textContent = signingUp ? "Create your account" : "Log in";
    accountNameField.hidden = !signingUp;
    accountNameField.querySelector("input").required = signingUp;
    accountPassword.autocomplete = signingUp ? "new-password" : "current-password";
    accountSubmit.textContent = signingUp ? "Sign Up" : "Log In";
    accountStatus.textContent = "";
  }

  function closeAccountDialogWindow() {
    accountBackdrop.classList.remove("is-visible");
    accountBackdrop.setAttribute("aria-hidden", "true");
    document.body.classList.remove("account-dialog-open");
    if (lastAccountTrigger) lastAccountTrigger.focus();
  }

  accountTriggers.forEach((trigger) => {
    trigger.addEventListener("click", () => {
      lastAccountTrigger = trigger;
      setAccountAction(trigger.dataset.accountAction);
      accountBackdrop.setAttribute("aria-hidden", "false");
      document.body.classList.add("account-dialog-open");
      accountBackdrop.classList.add("is-visible");
      accountBackdrop.querySelector(
        trigger.dataset.accountAction === "signup" ? "#account-name" : "#account-email"
      ).focus();
    });
  });

  closeAccountDialog.addEventListener("click", closeAccountDialogWindow);
  accountBackdrop.addEventListener("click", (event) => {
    if (event.target === accountBackdrop) closeAccountDialogWindow();
  });
  document.addEventListener("keydown", (event) => {
    if (!accountBackdrop.classList.contains("is-visible")) return;
    if (event.key === "Escape") {
      closeAccountDialogWindow();
      return;
    }
    if (event.key === "Tab") {
      const focusableElements = Array.from(
        accountBackdrop.querySelectorAll("button:not([disabled]), input:not([disabled])")
      ).filter((element) => element.getClientRects().length);
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    }
  });
  accountForm.addEventListener("submit", (event) => {
    event.preventDefault();
    accountStatus.textContent = accountAction === "signup"
      ? "This demo form cannot create an account yet."
      : "This demo form cannot sign you in yet.";
  });
}

// BACK TO TOP
const backToTopButton = document.createElement("button");
backToTopButton.className = "btn back-to-top";
backToTopButton.type = "button";
backToTopButton.setAttribute("aria-label", "Back to top");
backToTopButton.setAttribute("title", "Back to top");
backToTopButton.innerHTML = '<span aria-hidden="true">&uarr;</span>';
document.body.append(backToTopButton);

let previousButtonScrollY = window.scrollY;
let buttonScrollDistance = 0;
let previousButtonDirection = 0;
const buttonScrollThreshold = 8;

window.addEventListener("scroll", () => {
  const currentScrollY = window.scrollY;
  const scrollDifference = currentScrollY - previousButtonScrollY;
  const direction = Math.sign(scrollDifference);
  previousButtonScrollY = currentScrollY;

  if (currentScrollY <= 150) {
    buttonScrollDistance = 0;
    previousButtonDirection = 0;
    backToTopButton.classList.remove("is-visible");
    return;
  }
  if (direction === 0) return;
  if (direction !== previousButtonDirection) {
    previousButtonDirection = direction;
    buttonScrollDistance = 0;
  }
  buttonScrollDistance += Math.abs(scrollDifference);
  if (buttonScrollDistance >= buttonScrollThreshold) {
    backToTopButton.classList.toggle("is-visible", direction < 0);
    buttonScrollDistance = 0;
  }
}, { passive: true });

backToTopButton.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// TIMED WILDFIRE QUIZZES
const quizQuestionSets = {
  human: [
    { question: "Which situation is an example of a human-caused wildfire ignition?", choices: ["A lightning strike ignites a tree", "An unattended campfire spreads to dry grass", "Hot weather dries vegetation"], answer: 1, explanation: "An unattended campfire is a human activity that can ignite nearby vegetation." },
    { question: "What can dry, windy weather do?", choices: ["Make an existing fire spread faster", "Always ignite a fire by itself", "Put out every small fire"], answer: 0, explanation: "Dry, windy weather can increase fire danger and spread, but it is not itself an ignition source." },
    { question: "Why can an open debris burn become a wildfire?", choices: ["Smoke changes the weather", "Wind carries embers into dry vegetation", "Ash makes nearby plants grow"], answer: 1, explanation: "Escaping embers can ignite dry grass, leaves, or brush beyond the burn area." },
    { question: "What is the safer way to dispose of smoking materials outdoors?", choices: ["Drop them on bare-looking ground", "Put them in a proper container", "Throw them away from the road"], answer: 1, explanation: "Use a proper container and never discard smoking materials onto the ground or from a vehicle." },
    { question: "Before an outdoor burn, what should you do?", choices: ["Check local restrictions and conditions", "Assume burning is always allowed", "Leave as soon as the flames look small"], answer: 0, explanation: "Burn rules and conditions vary by location. Check local guidance and never leave a burn unattended." }
  ],
  natural: [
    { question: "What is a common natural cause of wildfire ignition?", choices: ["Lightning", "Low humidity", "Strong wind"], answer: 0, explanation: "Lightning can ignite vegetation. Low humidity and wind can increase danger or spread but are not ignition sources by themselves." },
    { question: "How can hot, dry, windy weather affect a wildfire?", choices: ["It can dry fuels and help fire spread", "It always starts a fire without an ignition source", "It makes vegetation fireproof"], answer: 0, explanation: "Weather can dry vegetation and help an existing fire spread more quickly." },
    { question: "Why might a lightning-caused fire be noticed later?", choices: ["It may smolder before becoming visible", "Lightning fires always start underground", "Clouds hide every fire for several days"], answer: 0, explanation: "Some lightning strikes can leave smoldering material that becomes visible later." },
    { question: "Besides lightning, what natural event can ignite fires in some places?", choices: ["Volcanic activity", "A change in humidity", "A cloudy day"], answer: 0, explanation: "Volcanic activity can ignite fires in some locations." },
    { question: "If authorities issue an evacuation order during a wildfire, what should you do?", choices: ["Approach the fire to check its cause", "Leave promptly and follow official instructions", "Wait until you can see flames"], answer: 1, explanation: "Follow local evacuation instructions promptly; do not approach a fire to investigate." }
  ],
  causes: [
    { question: "What is an ignition source?", choices: ["Something that starts a fire, such as a spark", "Vegetation that feeds an existing fire", "Wind that changes a fire's direction"], answer: 0, explanation: "An ignition source starts a fire; examples include lightning and sparks from human activity." },
    { question: "What role does dry grass or brush play in a wildfire?", choices: ["It is fuel that can feed the fire", "It always prevents fire spread", "It is an emergency alert"], answer: 0, explanation: "Vegetation is fuel that can burn and help a wildfire spread." },
    { question: "Which statement about wind and drought is most accurate?", choices: ["They can increase spread or dry fuels, but do not necessarily ignite a fire", "They are the only possible ignition sources", "They always stop wildfires"], answer: 0, explanation: "Wind and drought can worsen fire conditions, while an ignition source is still needed to start a fire." },
    { question: "How can wildfire smoke affect people far from the flames?", choices: ["It can travel and worsen air quality", "It only affects people inside the burn area", "It makes outdoor air cleaner"], answer: 0, explanation: "Smoke can travel far from a fire and affect air quality and health." },
    { question: "What should a household do to prepare for possible evacuation?", choices: ["Plan routes and keep essential items ready", "Wait to make a plan until smoke appears", "Use only roads leading toward the fire"], answer: 0, explanation: "Plan evacuation routes in advance and follow official alerts and instructions." }
  ]
};

document.querySelectorAll("[data-timed-quiz]").forEach((quiz) => {
  const questions = quizQuestionSets[quiz.dataset.timedQuiz];
  if (!questions) return;

  const timeLimit = 15;
  const intro = quiz.querySelector(".quiz-intro");
  const round = quiz.querySelector(".quiz-round");
  const results = quiz.querySelector(".quiz-results");
  const progressLabel = quiz.querySelector(".quiz-progress-label");
  const timer = quiz.querySelector(".quiz-timer");
  const secondsLabel = quiz.querySelector(".quiz-seconds");
  const progress = quiz.querySelector(".quiz-progress");
  const progressBar = progress.querySelector(".progress-bar");
  const questionHeading = quiz.querySelector(".quiz-question");
  const options = quiz.querySelector(".quiz-options");
  const feedback = quiz.querySelector(".quiz-feedback");
  const nextButton = quiz.querySelector(".quiz-next");
  const scoreLabel = quiz.querySelector(".quiz-score");
  let questionIndex = 0;
  let score = 0;
  let secondsRemaining = timeLimit;
  let timerInterval = null;
  let answered = false;

  function stopTimer() {
    window.clearInterval(timerInterval);
    timerInterval = null;
  }

  function updateTimer() {
    secondsLabel.textContent = String(secondsRemaining);
    progress.setAttribute("aria-valuenow", String(secondsRemaining));
    progressBar.style.width = `${(secondsRemaining / timeLimit) * 100}%`;
    timer.classList.toggle("is-urgent", secondsRemaining <= 5);
  }

  function finishAnswer(selectedAnswer) {
    if (answered) return;
    answered = true;
    stopTimer();
    const currentQuestion = questions[questionIndex];
    const choiceButtons = Array.from(options.querySelectorAll("button"));

    choiceButtons.forEach((button, index) => {
      button.disabled = true;
      if (index === currentQuestion.answer) button.classList.add("is-correct");
      if (index === selectedAnswer && selectedAnswer !== currentQuestion.answer) {
        button.classList.add("is-incorrect");
      }
    });

    if (selectedAnswer === currentQuestion.answer) {
      score += 1;
      feedback.textContent = `Correct! ${currentQuestion.explanation}`;
      feedback.className = "quiz-feedback mt-3 mb-0 is-correct";
    } else if (selectedAnswer === null) {
      feedback.textContent = `Time's up. ${currentQuestion.explanation}`;
      feedback.className = "quiz-feedback mt-3 mb-0 is-incorrect";
    } else {
      feedback.textContent = `Not quite. ${currentQuestion.explanation}`;
      feedback.className = "quiz-feedback mt-3 mb-0 is-incorrect";
    }

    nextButton.textContent = questionIndex === questions.length - 1 ? "See your score" : "Next question";
    nextButton.hidden = false;
    nextButton.focus();
  }

  function showQuestion() {
    answered = false;
    secondsRemaining = timeLimit;
    const currentQuestion = questions[questionIndex];
    progressLabel.textContent = `Question ${questionIndex + 1} of ${questions.length}`;
    questionHeading.textContent = currentQuestion.question;
    questionHeading.focus();
    feedback.textContent = "";
    feedback.className = "quiz-feedback mt-3 mb-0";
    nextButton.hidden = true;
    options.replaceChildren();

    currentQuestion.choices.forEach((choice, index) => {
      const button = document.createElement("button");
      button.className = "btn btn-outline-dark quiz-choice text-start";
      button.type = "button";
      button.textContent = choice;
      button.addEventListener("click", () => finishAnswer(index));
      options.append(button);
    });

    updateTimer();
    stopTimer();
    timerInterval = window.setInterval(() => {
      secondsRemaining -= 1;
      updateTimer();
      if (secondsRemaining <= 0) finishAnswer(null);
    }, 1000);
  }

  function startQuiz() {
    stopTimer();
    questionIndex = 0;
    score = 0;
    intro.hidden = true;
    results.hidden = true;
    round.hidden = false;
    showQuestion();
  }

  quiz.querySelector(".quiz-start").addEventListener("click", startQuiz);
  quiz.querySelector(".quiz-restart").addEventListener("click", startQuiz);
  nextButton.addEventListener("click", () => {
    questionIndex += 1;
    if (questionIndex < questions.length) {
      showQuestion();
      return;
    }

    stopTimer();
    round.hidden = true;
    results.hidden = false;
    scoreLabel.textContent = `You scored ${score} out of ${questions.length}.`;
    results.querySelector(".quiz-restart").focus();
  });
});

// PAGE TRANSITIONS
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (!prefersReducedMotion) {
  const revealTargets = document.querySelectorAll(
    "main > header, main section > .container > .text-center, main article, main section .row > [class*='col-'] > div, main section .row > [class*='col-'] > aside, main .source-disclosure"
  );

  if ("IntersectionObserver" in window) {
    const revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-revealed");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });

    revealTargets.forEach((element, index) => {
      element.classList.add("scroll-reveal");
      element.style.setProperty("--reveal-delay", `${(index % 4) * 70}ms`);
      element.style.setProperty("--reveal-x", index % 2 === 0 ? "-2rem" : "2rem");
      element.style.setProperty("--reveal-flip", index % 3 === 2 ? "10deg" : "0deg");
      revealObserver.observe(element);
    });
  }

  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) return;

    const link = event.target.closest("a[href]");
    if (!link || link.target || link.hasAttribute("download")) return;

    const destination = new URL(link.href, window.location.href);
    if (
      destination.origin !== window.location.origin ||
      !destination.pathname.toLowerCase().endsWith(".html") ||
      destination.href === window.location.href ||
      (destination.pathname === window.location.pathname && destination.hash)
    ) return;

    event.preventDefault();
    document.body.classList.add("page-transition-leaving");
    window.setTimeout(() => {
      window.location.href = destination.href;
    }, 220);
  });
}

// NAVIGATION
// Hide the navigation bar when scrolling down; show it when scrolling up.
const siteNavbar = document.querySelector(".site-navbar");

if (siteNavbar) {
    let previousScrollY = window.scrollY;
    let lastDirection = 0;
    let distanceInDirection = 0;
    let isHidden = false;
    const scrollThreshold = 24;
    const navbarMotion = siteNavbar.animate(
        [
            { transform: "translateY(0)", opacity: 1 },
            { transform: "translateY(-100%)", opacity: 0 }
        ],
        {
            duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 400,
            easing: "ease-in-out",
            fill: "both"
        }
    );

    navbarMotion.pause();
    navbarMotion.currentTime = 0;

    const setNavbarHidden = (hidden) => {
        if (hidden === isHidden) {
            return;
        }

        isHidden = hidden;
        navbarMotion.playbackRate = hidden ? 1 : -1;
        navbarMotion.play();
    };

    window.addEventListener("scroll", () => {
        const currentScrollY = window.scrollY;
        const scrollDifference = currentScrollY - previousScrollY;
        previousScrollY = currentScrollY;

        if (currentScrollY <= siteNavbar.offsetHeight) {
            distanceInDirection = 0;
            lastDirection = 0;
            setNavbarHidden(false);
            return;
        }

        const direction = Math.sign(scrollDifference);

        if (direction === 0) {
            return;
        }

        if (direction !== lastDirection) {
            lastDirection = direction;
            distanceInDirection = 0;
        }

        distanceInDirection += Math.abs(scrollDifference);

        if (distanceInDirection >= scrollThreshold) {
            setNavbarHidden(direction > 0);
            distanceInDirection = 0;
        }
    }, { passive: true });
}
