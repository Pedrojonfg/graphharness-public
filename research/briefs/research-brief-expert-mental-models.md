# Research Brief: Transmitting experts' mental models (and how much AI helps)
**Depth**: wide (with deep points on the evidence about AI)
**Date**: 2026-11-18
**Research time**: ~1 session
**How to read it**: every claim carries a confidence tag. **[P]** = I read the primary source. **[S]** = I only saw it in summaries/search snippets (verify before citing). **[I]** = my own inference, not a published result.

## Executive summary

1. **Your intuition is backed up, but with a nuance that changes the design.** There are two different things: the *click* (understanding why something is true, the mental model) and *intuition* (seeing it at a glance, with fluency). Explanation produces the click; what turns it into intuition is varied practice with feedback. The literature on "experts' mental models" is really two literatures that barely talk to each other: instruction (how to transmit the model) and perceptual learning (how it becomes automatic). **[I]**, supported by Thurston, Chi et al. and Kellman.
2. **Experts are poor transmitters of their own models.** Much of what they do is tacit (cited figure: ~70 % of decisions omitted when describing a task **[S]**) and more subject knowledge makes it *harder* to predict what a novice finds difficult (expert blind spot **[S]**). That is why "asking an expert to explain it" is not enough; models have to be extracted and structured explicitly.
3. **What works for moving from hard to intuitive is fairly well identified**: trying before being told (productive failure, g≈0.36 **[S]**), comparing contrasting cases, moving from concrete to abstract gradually, multiple representations of the same object (Thurston with the derivative **[P]**) and perceptual pattern training. LH already implements the first half well (predict → teach → check); what it lacks is the half that turns the click into intuition.
4. **AI: effective as a guided tutor, not shown to transmit intuition.** With safeguards it avoids the harm caused by unrestricted chat (Bastani: −17 % on the exam without AI with GPT Base **[S]**), and it improves performance *during* practice; lasting effects are small (0.06–0.14 SD with Khanmigo **[P]**; null on a standardized test at 10 weeks with the Eedi/DeepMind tutor **[S]**). There is one promising exception: at Middlebury, using AI as a tutor ("augmentation") keeps the gain a week later and using it to write for you ("automation") loses it **[P]**. **I found no study that measures "mental model quality" or "intuition"**; all of them measure test scores. That is a real gap, and also an opportunity for your app.
5. **Core risk: AI fluency fabricates a feeling of understanding.** Long, polished explanations raise confidence without raising the ability to tell what is correct **[S]**; and useful effort *feels* like learning less (Deslauriers **[S]**). For an app whose central pleasure is "the hard becomes obvious", this matters: the click has to be measured with deferred, AI-free retests, not with the feeling.

## 1. What exactly we want to transmit

| Idea | Source | What it implies | Conf. |
|---|---|---|---|
| Experts categorize by **deep structure** (the principle), novices by surface features (the spring, the inclined plane) | Chi, Feltovich & Glaser 1981 (small sample: 8 students in the cited replication) | An expert mental model is above all a *way of classifying problems*. Teaching it = teaching to see what two seemingly different problems have in common | [S] |
| A concept is understood in **several logically non-equivalent ways** (the derivative as slope, as instantaneous velocity, as best linear approximation…) and the expert jumps from one to another almost without noticing | Thurston 1994 "On proof and progress" | The unit of teaching is not "the definition" but **a catalog of ways of thinking** about the same object, with when to use each | [P] |
| The formal definition and the proof **do not transmit** those models: "once precise and formal, the differences start to evaporate"; one-on-one, "wide channels" (gestures, drawings) are used that a paper does not have | Thurston 1994 | Models travel through conversation, image and gesture. An argument in favor of a dialogic tutor with figures (and in favor of what you already did with TikZ, ADR 108) | [P] |
| Concept image (what you really have in your head) ≠ concept definition (what you would say if asked); the image can be incoherent and contradict the definition | Tall & Vinner 1981 | Diagnosis must uncover the student's *image*, not just whether they recite the definition | [S] |
| A procedure becomes a manageable **object** (reification); the symbol is both process and concept | Sfard 1991; Gray & Tall 1994 | Part of "becoming intuitive" is being able to treat as a single thing what used to be a sequence of steps | [S] |
| Much expert knowledge is **automated** and therefore not verbalizable; free interviews introduce omissions and errors, structured cognitive task analysis (CTA) performs better | Clark & Feldon; Feldon & Stowe 2009 | Models are not obtained by asking "how do you think?", but with structured elicitation and cases | [S] |
| Knowing the subject is **not enough** to teach it: what predicts students' progress is mathematical knowledge *for teaching* | Hill, Rowan & Ball 2005 (1 SD of teacher knowledge ≈ 0.1 SD in students) | The AI teacher needs to know the novice's typical errors and sticking points, not just the math | [S] |
| Problem-solving competence is not only content: also heuristics, **control** (deciding what to do and when to give up) and beliefs. Many math PhDs did **not** show that behavior | Schoenfeld 1985; replication DeFranco 1996 | "Mental models" include *how one decides what to try*, not just images of the concept | [S] |

**Reading for your idea**: the "mental model of the greatest expert" is not an isolated pretty metaphor; it is (a) the image or images of the object, (b) the classification of problems by deep structure, (c) the control heuristics and (d) the "nose" for knowing that something is going wrong. Most products only transmit (a), if anything.

## 2. The hard → intuitive transition: which techniques produce it

| Technique | Evidence | Limits / nuances | Conf. |
|---|---|---|---|
| **Trying before being told** (productive failure, PS-I) | Meta-analysis of 53 studies / 166 comparisons: g=0.36 in favor of PS-I; higher (0.37–0.58) if the design is followed faithfully; better on conceptual than procedural | Invested in grades 2–5 and in domain-general skills; a later meta-analysis finds no advantage if the comparison group already has prior scaffolding | [S] |
| **Contrasting cases** and "inventing before being told" | Schwartz & Bransford 1998; Schwartz et al. 2011: telling you the concepts first can harm learning of deep structure; both groups equally capable of applying the formula, but different transfer | The advantage is not uniform across measures | [S] |
| **Comparing two examples** (analogical encoding) | Guided comparison favors learning and transfer more than studying them separately or solving them; **without guidance many do not compare** and comparison *prompts* worked, "explain" ones did not (in one study) | Multiple sources do not guarantee transfer without support | [S] |
| **Concreteness fading** (concrete → abstract) | Better transfer than concrete only; abstract only is worse at the start | A 2020 analysis questions how far it generalizes across domains | [S] |
| **Perceptual learning** (Kellman's modules) | Training structure recognition (matching representations, classifying) improves fluency and "structural intuition" in algebra and fractions | Modest field studies; results from the company that sells them | [S] |
| **Worked examples → problems** according to level (expertise reversal) | Worked examples help the novice and stop helping (or get in the way of) the advanced learner | Much evidence uses subjective load measures; generality outside well-structured tasks is questioned | [S] |
| **Reliable intuition = regular environment + many repetitions with feedback** | Kahneman & Klein 2009 | Mathematics is a very regular environment with immediate (checkable) feedback: good ground for training intuition. They do not say this of mathematics; it is my application **[I]** | [S] |
| **Spaced retrieval embedded in the text** (Quantum Country) | For hard cards, recall rose from ~42 % to ~70 % with practice in the essay; after demonstrating retention, ~95 % correct | Informal notes from the authors; they measure recall, which they themselves say is a poor proxy for comprehension | [S] |

**A nuance worth keeping**: Thurston says his personal mental models are usually different from those the group shares, and that standard models "are learned easily later". My reading **[I]**: the deep model is not "downloaded", it is rebuilt in your head with help, which matches LH's rule that the student should be able to have discovered it.

## 3. The pleasure of the transition (why it matters for your app)

- **The "aha!" has a reward correlate and improves memory**: it activates the striatum and amygdala, and insight solutions are consolidated better (Kizilirmak 2016; Ludmer et al. 2011). It is single-lab fMRI and laboratory tasks (words, degraded images), not real math. **[S]**
- **Curiosity is an information gap**: what one is curious about is learned better, and so is incidental material during that state (Gruber 2014; PACE framework). It is the foundation of why LH's prior **prediction** works as a hook. **[S]**
- **Thurston says it better**: "there is a real joy in doing mathematics, in learning ways of thinking that explain, organize and simplify", and he mentions going back to old concepts with "an added meaning". **[P]**
- **Counterweight**: the effort that gives that pleasure is *interpreted* as learning little. In Deslauriers (2019) students learned more with an active class and felt they learned less. **[S]** The app should be honest about this instead of optimizing the feeling of the moment.

## 4. Evidence about AI

| Study | What it did | Result | Reading | Conf. |
|---|---|---|---|---|
| **Bastani et al., PNAS 2025** (Turkey, ~1,000 high-school students, math) | GPT Base (free chat) vs GPT Tutor (with safeguards) vs control | Practice: +48 % / +127 %. Exam without AI: GPT Base −17 % (≈−0.19 SD); GPT Tutor ≈ control | AI without guardrails is a crutch; with them harm is avoided, but the exam is **not improved** | [S] |
| **Kestin et al., Sci. Reports 2025** (Harvard, 194 students, physics) | AI tutor with pedagogical principles (not giving answers) vs active-learning class, crossover design | Median 4.5 vs 3.5 out of 6; less time | Positive, but **two topics, short term** and compared with a class, not with a human tutor | [S] |
| **Contractor & Reyes, 2026** (Middlebury, 211 students, essay + in-person tests without AI) | With vs without AI when studying a new topic | +0.28 SD immediately, +0.21 SD a week later. The gain holds if they use it as a tutor and **fades if they ask it to write for them**. Most common uses: asking for explanations (56 %) | The *mode of use* decides the outcome. Fits LH (the AI teaches, the student answers) | [P] |
| **Oreopoulos & Low, 2026** (Khanmigo, 18 Tennessee schools, 2 grades) | Khan Academy with and without an AI tutor configured not to give answers | +1.3 percentiles/term ≈ 0.06–0.08 SD/year (0.14 SD for continuous active participation); **same as Khan without AI**. 96 % tried it, but the median student used it only 1 day in 3 and in 17 % of sessions with an error. Messages: mostly single answers or clicks on suggestions | **The bottleneck is engagement**, not model capability | [P] |
| **NBER 2026, Hamilton County** (6,997 students in grades 6–8, one ~50 min session) | Guided tutor vs platform without AI, with and without required mastery | After an error, +8.5 pp correct on the next attempt, but 2.9 min longer; a week later +3.2 pp on the practiced exercise (p=0.065) and nothing on the unpracticed one | Helps in the moment; deferred transfer is weak or null. One session, 4 test questions, no peer review | [S] |
| **Eedi + Google DeepMind, 2025–26** (1,179 students, 10 UK schools) | After an error: standard remediation vs human tutor vs AI vs AI with human approval | 56–58 % correct on the next question with any tutoring vs 43 % standard; the AI tutor matched the human. **No advantage on the standardized test** at ~10 weeks | As above: good in the moment, nothing measurable at 10 weeks (the authors say the time frame is short). I do not have the primary report | [S] |
| **Tutor CoPilot, Stanford** (>700 tutors, ~1,000 students) | AI that suggests to human tutors responses "with an expert's thinking" | +4 pp lesson mastery (up to +9 pp with lower-rated tutors); tutors gave fewer direct answers and asked more questions. Tutors sometimes found them "too smart" and had to simplify them | **The result closest to your idea**: a model of expert thinking *distilled from expert teachers* improves teaching. And the expert-blind-spot symptom also appears in AI | [S] |
| **LearnLM (Google)** | Model tuned for following pedagogical instructions | Experts prefer LearnLM over GPT-4o (31 %), Claude 3.5 Sonnet (11 %) | Evaluator preference over outputs, not learning | [S] |
| **MIT "Your Brain on ChatGPT", 2025** | EEG during essay writing (54 people) | Lower connectivity with LLM; users quoted their own text worse | Preprint, small sample, writing task, not math; the authors themselves ask for caution | [S] |
| **Illusion of understanding** (Fernandes 2026; Steyvers; Aslanov) | Reasoning with AI | With AI scores go up but accuracy is overestimated by ~4 points; longer explanations raise confidence without improving discrimination | Preprints/proceedings; directionally consistent | [S] |

**General trend**: AI reliably improves performance *with help*; deferred effects are small and conditional on *how* it is used. With guardrails harm is avoided; what almost nobody has shown is the big leap. Bloom's numbers (2 sigma) have **not** been replicated with AI in any study I found.

**What AI does well for your idea**: explaining with unlimited patience, generating many case variants, adapting to the student, sustaining a dialogue with images (Thurston's "wide channels"), and distilling experts' models *if given them* (Tutor CoPilot).

**What it does badly or is not demonstrated**:
- **It has no "nose"**: Tao says AI-generated proofs often "look perfect" and that he cannot tell when it has taken a wrong path **[S]**. A tutor without a nose of its own is a risk when the student cannot yet detect the error.
- **Expert bias**: a CMU paper suggests that LLMs, pretrained on experts' explanations, simulate the novice poorly (verbose, too coherent) **[S]** — it is indirect: it studies the LLM *playing the student*, not the tutor. Even so it matches the "too smart" of Tutor CoPilot.
- **Engagement**: AI is no use if the student does not ask (Khanmigo: 17 %). In LH this is less serious because the teacher leads.
- **Tao on his own field**: he warns that if AI does the routine steps young people may lose the chance to form deep intuition, and advises learning the traditional methods first **[S]** (secondary source; no primary transcript).

## 5. Where LH stands today with respect to this (read from `src/agent/prompts/teacher/` in the fork)

It already does, and very much in line with the literature:
- **Unconditional facts first + "how might I have discovered it?"**, with 3Blue1Brown as reference (`05-method.md`). It is LH's version of "the click as collapsing loose facts into a generator".
- **Predict → teach → check** (`28-predictions.md`): an open prediction before the step = productive failure in miniature and information-gap curiosity.
- **Applied checks, not recitation, with distractors that name the wrong model** (`30-question-principles.md`): it is concept-image diagnosis.
- **Repair before moving on; a recurring "slip" is a pattern** (`32-repair-and-requests.md`).
- On the Hub side: mastery with decay and evidence weights (ADR 106), cards, code-graded exercises (`eval`), `/errors`, `/profile`, TikZ figures (ADR 108).

What does **not** appear (according to the prompts and the design documents I read; I have not audited all the code):
1. **A place for mental models as a first-class object.** The Hub stores *what you know* about each concept, not *with which images/representations* that concept is thought about nor where they come from (which expert). The model lives only in the head of each session's LLM, variable and unrepeatable.
2. **Multiple representations and "when to use which"** as an explicit practice (Thurston).
3. **Intuition training after the click**: classifying problems by structure without solving them, estimating before computing, spotting the absurd answer, timed work/fluency. Today the Hub measures correctness, not fluency or the quality of the mental image.
4. **Contrasting cases** and **concreteness fading** as explicit guidance (LH has demos and TikZ, but not the "from concrete to abstract" doctrine nor "compare these two").
5. **Fading scaffolding with mastery** (expertise reversal): `hub_mastery` reports the state, but I have not seen the guidance switch from "worked example" to "direct problem" when the state rises.
6. **Tracking the change in intuition**: your "transition from counterintuitive to intuitive" could be recorded and it is very motivating; today it has no entity.
7. **Defense against the illusion of understanding**: the deferred AI-free retest exists in the form of cards, but there is no metric comparing "feeling at the end of the session" with "deferred correctness".

## 6. Ideas for the app (hypotheses to discuss, not decisions)

Ordered from most to least supported by evidence per estimated effort. All respect the Hub's golden rule: what is gradable is done by code, the LLM drafts.

| # | Idea | What would change | Support | Risk |
|---|---|---|---|---|
| A | **Mental-model sheets per concept** (new entity in the Hub): name; image or metaphor; which deep structure it captures; when to activate it (trigger); **when it lies** (limit); the novice error it corrects; **source** (author, work, passage); alternative representations. LH receives them like `hub_mastery` and teaches *through* them | Hub (model + MCP + PWA), LH (new prompt, patch) | Thurston, Chi, Tutor CoPilot, Hill/Ball | The LLM invents or misattributes. Mitigate: mandatory source field and a `verified by Pedro` state |
| B | **Extraction pipeline** for models from sources you upload (Thurston, Tao's blog, Sanderson transcripts, Feynman, Needham, course notes…), with short literal quotes, so that *you* approve each sheet | `ingest` already exists for university material | Structured CTA > free recall (Clark/Feldon) | Copyright (short quotes); review work for you |
| C | **"Intuition" mode** post-click: structure-recognition exercises (classify without solving), prior estimation with tolerance, "which answer is absurd?", surface variants with the same structure. `eval` grades deterministically; records time | `eval` + PWA + new evidence with its own weight | Kellman, Chi, Kahneman-Klein | It must be decided how much fluency weighs in the mastery state (your decision, like the thresholds) |
| D | **New teaching guidelines** in the teacher prompt: contrasting cases before naming; concrete→abstract with a clear "now I remove the scaffolding" signal; "compare A with B" as a guided question (comparison prompts worked, explanation ones did not) | LH, prompt texts (`20-teaching.md`); a subagent drafts them and you review them, as so far | Schwartz, Fyfe, Gentner | More verbosity; LH's AGENTS.md requires you to be asked before touching design |
| E | **Fade scaffolding with mastery** (expertise reversal): with a high state, a direct problem with no worked example | LH prompt + `hub_mastery` signal | Kalyuga | Subjective measures in the literature |
| F | **Journal of counterintuitive things**: save your initial prediction and the resolution; re-evaluate months later whether it is now intuitive. It is the metric of *your* transition | Hub (new lightweight entity) + scheduled card | Gruber (curiosity), your own motivation | Little direct experimental support; mostly motivational value **[I]** |
| G | **Calibration**: after each session, ask "how much do you think you master it?" and compare it in the deferred retest; show the gap in `/profile` | PWA + data that already exists | Deslauriers, Fernandes | It may be uncomfortable; that is the point |
| H | **A small "nose" bank**: answers/proofs with a subtle error you must locate, generated with the known error (code control) | `eval` + cards | Tao's observation [S] about AI; control heuristics (Schoenfeld) | Generating *realistic* errors without the LLM getting the solution wrong |

What I would **not** recommend without more evidence: gamifying the "aha!" (the support is laboratory fMRI), measuring success by session satisfaction (Deslauriers), or giving the LLM free rein to "remember how So-and-so would explain it" (attribution hallucination).

## 7. Risks and what this research could not answer

- **There is no direct study** of "transmitting experts' mental models with AI"; the whole bridge between the "expertise literature" and the "AI tutor" is my inference. The closest piece is Tutor CoPilot (an expert-thinking model distilled from teachers that helps human tutors), with a modest effect.
- **Many 2026 results are preprints or working papers** (NBER, EdWorkingPaper, arXiv) and have not passed peer review. I read in full only those of Khanmigo (abstract and first pages) and Contractor & Reyes (abstract and introduction) and the NBER press release on Tennessee; the rest are search summaries.
- **Several figures contradict each other across sources** (Tutor CoPilot sample size; Eedi duration). I use them as ranges and with their tag.
- **Figures I did not verify in the original**: the "70 %" of Clark & Feldon, Kestin's numbers, Kapur's g, Chi 1981's and Tao's quotes.
- **No evidence for self-taught adult study with personalized AI models**; almost everything is from school or early university.
- **Possible selection bias**: I mainly searched for what supports the thesis (experts' models work); I looked for counterweights (expertise reversal, Deslauriers, Khanmigo, Tao) but did not review in depth critiques of the very notion of "mental model" (for example, that much of mathematical intuition is habit rather than image).

## 8. Open questions to decide with you

1. What do you mean by "mental model" in your current study: an **image or metaphor** (like 3Blue1Brown), a **way of classifying problems**, or a **heuristic for attacking problems**? The answer changes which field the sheet would have (idea A).
2. Do you want to curate the sheets yourself from specific sources (idea B) or would you rather the teacher generate them and you only correct them?
3. Does **fluency** (time, estimation, fast classification) enter the mastery state or is it a separate indicator?
4. Which subjects are the test bed: computable math (eval already grades) and/or the one you are studying now (numerical calculus)? Structure-recognition exercises are much easier in the former.

## 9. Decisions made with Pedro (2026-11-18, after the conversation following the brief)

1. **Direction**: force the teacher to explain each concept from **several lenses** (different ways of seeing it: algebraic, geometric, game/process…), not just more demos. A demo is a way of drawing a dynamic lens, not the lens. Origin: Pedro saw `Ax = b` as "how many times I press each key to reach a point" (a column image).
2. **Scope**: only on **core nodes** of the plan.
3. **Authorship**: the lenses are **proposed by the teacher**; at the end of the session Pedro marks **which he liked most** as an improvement signal.
4. **Holistic approach (new)**: on each core node, look for **other places where the same concept lives** (linear dependence in ODEs, subspaces of matrices, of functions…). Pedro's experience: seeing linear dependence in ODEs "broke his head" because it revealed that the concept was not from linear algebra but from *structure*.

5. **Two approved mechanisms**: (a) within the session, the teacher gives a second instance of the core in a domain the student already knows; (b) across subjects, the Hub flags "re-encounters" (requires shared concepts, ADR 105 point 14).
6. **Third mechanism: "expansion"** (Pedro's idea). Even when there is no prior concept, a short addition, **not assessable and marked as such**, that widens the concept ("just as functions can be differentiated, matrices can be differentiated; the meaning would be…", with a minimal example). Goal: for the student not to be left with the procedural prototype ("differentiating = lowering the exponent"). It does not teach how to *do* it, only to see that the concept is bigger.
   - **Support**: an overly narrow concept image → errors (Tall & Vinner **[S]**).
   - **Risk**: *seductive details* (interesting but irrelevant material): Rey 2012 meta-analysis, d≈0.3 on recall and ≈0.48 on transfer **[S]**, with less harm when load is low. The expansion *is* relevant, but it should be limited: arrive **after** the core's check, short (a few lines + an example), with the label "Expansion — not assessed" and **collapsed behind an opt-in button** (as checks already arrive in LH), so that it does not burden whoever does not ask for it.
   - **Correctness risk**: since it is not assessed, nothing would catch an LLM error (e.g. differentiating matrices, properly stated, is the Jacobian/Fréchet derivative). Verify with the `research` tool or restrict it to a curated catalog.
7. **Closing and voting on lenses**: the Hub already closes sessions (REST `POST /sessions/:chatId/close`, MCP `close_session`, auto-close at 45 min); the "Close" button exists **only in the PWA** (`Sesiones.tsx`), **not in LH**. A closing card in LH requires a new LH patch with an "End session" button that calls the Hub.

**Support for point 4**: with **two** analogous stories people induce the underlying schema and transfer; with only one, they do not, even if given a statement or diagram (Gick & Holyoak 1983 **[S]**). The induced schema improves transfer, and spontaneous transfer is weak without help (Catrambone & Holyoak 1989 **[S]**). Therefore the *encounter* with the second case must be provoked by the app: the student will not notice it alone.

**Nuances that condition the design**:
- **Conflict with LH's current doctrine.** `10-planning.md` says the plan is the "minimal tree" and that "nothing off the path to their goal is taught, however interesting". Lenses and other domains are justified as **part of the path to the core**, not as decoration, and the prompt has to say so; otherwise the planner will prune them.
- **Order**: first a case that already works, then the second case in another domain, then the abstract name. It worked for Pedro in ODEs because he already had linear dependence solid; if it is introduced earlier, it is noise.
- **Abstract vs concrete is not settled**: the "advantage of abstract examples" (Kaminski 2008) weakened when the design of concrete examples was improved (Trninic, Kapur & Sinha 2020) **[S]**. The conclusion that holds: the *quality and variety* of the examples matters, not their level of abstraction.
- **Concepts shared between subjects** (ADR 105, point 14) was already postponed to V3 with "its own ADR first". It is the natural place where "linear dependence in linear algebra = linear dependence in ODEs" lives; the Hub knows what you have studied in each subject and can remind the teacher.
- **"I liked it" is not "it taught me"**: Deslauriers (2019) shows that feeling and learning diverge. It is advisable to store the preference *and* the later performance on questions tagged with that lens.

## Sources

**Expertise, mental models and instruction**
- Thurston, [On proof and progress in mathematics](https://ar5iv.labs.arxiv.org/html/math/9404236) [P]
- Chi, Feltovich & Glaser 1981, [Categorization and representation of physics problems by experts and novices](https://apps.dtic.mil/sti/pdfs/ADA100301.pdf)
- Nathan et al., [Expert blind spot](https://website.education.wisc.edu/~mnathan/Publications_files/2001_NathanEtAl_ICCS_EBS.pdf)
- Clark & Feldon, [Why does cognitive task analysis make a difference?](https://digitalcommons.usu.edu/itls_facpub/355)
- Hill, Rowan & Ball 2005, [Effects of teachers' mathematical knowledge for teaching](https://annenberg.brown.edu/publications/effects-teachers-mathematical-knowledge-teaching-student-achievement)
- Schoenfeld / DeFranco, [DeFranco 1996](https://Www.Gwern.net/doc/psychology/1996-defranco.pdf)
- Tall & Vinner, [Concept image and concept definition](https://core.ac.uk/download/48984.pdf)

**Learning techniques**
- Sinha & Kapur 2021, [meta-analysis PS-I vs I-PS](https://doi.org/10.3102/00346543211019105)
- Schwartz & Bransford 1998, [A time for telling](https://www.wright.edu/sites/www.wright.edu/files/uploads/2017/Feb/event/Schwartz_Bransford_1998_TimeForTelling.pdf); Schwartz et al. 2011, [Practicing versus inventing](https://ece.northeastern.edu/edsnu/mcgruer/USC/PracticingVersusInventing2011-edu-103-4-759.pdf)
- Fyfe et al. 2014, [Concreteness fading](https://pc.cogs.indiana.edu/?p=885); [2020 critique](https://link.springer.com/article/10.1007/s10648-020-09581-7)
- Gentner / analogical encoding, [PMC10481337](https://pmc.ncbi.nlm.nih.gov/articles/PMC10481337)
- Gick & Holyoak 1983, [Schema induction and analogical transfer](https://Www.Gwern.net/doc/psychology/1983-gick.pdf); Catrambone & Holyoak 1989, [PDF](https://sites.lifesci.ucla.edu/psych-reasoninglab/wp-content/uploads/sites/273/2021/04/Catrambone_Holyoak1989.pdf)
- Trninic, Kapur & Sinha 2020, [The disappearing advantage of abstract examples](https://edrl.berkeley.edu/publications/trninic-d-kapur-m-sinha-t-2020-the-disappearing-advantage-of-abstract-examples-in-learning-math/)
- Ainsworth 2006, [DeFT: multiple representations](https://nottingham-repository.worktribe.com/output/23577631/deft-a-conceptual-framework-for-considering-learning-with-multiple-representations); [2026 meta-analysis of multiple representations in mathematics](https://guok.bnu.edu.cn/docs/2026-05/071985c2192e4f508ddb32d6a363f5e2.pdf)
- Kellman et al., [Perceptual learning modules](https://pmc.ncbi.nlm.nih.gov/articles/PMC6124488)
- Kalyuga, [Expertise reversal](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2022.1032003/pdf)
- Kahneman & Klein 2009, [Conditions for intuitive expertise](https://pubmed.ncbi.nlm.nih.gov/19739881/)
- Matuschak & Nielsen, [notes on the mnemonic medium](https://notes.andymatuschak.org/zuCfBJSkm5BnqC1qw1bLH2)

**Pleasure, curiosity, illusion of learning**
- Kizilirmak et al. 2016, [Learning by insight](https://www.frontiersin.org/articles/10.3389/fpsyg.2016.01693/pdf); Ludmer et al., [coverage](https://neurosciencenews.com/new-insight-into-aha-memories-amygdala-role-long-term-memory/amp/)
- Gruber & Ranganath, [PACE](https://orca.cardiff.ac.uk/96033)
- Deslauriers et al. 2019, [feeling of learning](https://pubmed.ncbi.nlm.nih.gov/31484770/)

**AI and learning**
- Bastani et al., [Generative AI without guardrails can harm learning (PNAS 2025)](https://ideas.repec.org/a/nas/journl/v122y2025pe2422633122.html)
- Kestin et al., [AI tutoring outperforms in-class active learning](https://pmc.ncbi.nlm.nih.gov/articles/PMC12179260/)
- Contractor & Reyes 2026, [Experimental evidence on the learning impact of generative AI](https://arxiv.org/abs/2607.08849)
- Oreopoulos & Low 2026, [One click away: Khanmigo](https://edworkingpapers.com/sites/default/files/ai26-1551.pdf)
- [NBER Tennessee study (coverage)](https://www.edtechinnovationhub.com/news/ai-tutor-slows-math-practice-but-improves-post-mistake-recovery-in-6997-student-trial)
- Eedi + Google DeepMind, [LearnLM](https://arxiv.org/pdf/2412.16429), [Oct. 2026 report](https://services.google.com/fh/files/misc/learnlm_oct26.pdf), [Eedi](https://www.eedi.com/news/just-launched---our-second-ai-tutor-rct)
- Tutor CoPilot, [arXiv 2410.03017](https://arxiv.org/pdf/2410.03017)
- [Your Brain on ChatGPT (MIT)](https://www.media.mit.edu/publications/your-brain-on-chatgpt/)
- Fernandes et al., [arXiv 2603.29681](https://arxiv.org/pdf/2603.29681); Aslanov et al., [illusion of explanatory depth](https://escholarship.org/uc/item/8cr599sr)
- [LLMs as think-aloud students (CMU)](https://arxiv.org/pdf/2602.01015)
- Tao, [The Decoder](https://the-decoder.com/math-genius-terence-tao-says-that-ai-still-cant-smell-bad-math/), [Quanta, April 2026](https://www.quantamagazine.org/the-ai-revolution-in-math-has-arrived-20260410/)
