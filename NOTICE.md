# Notice

GraphHarness is released under the [MIT License](LICENSE).

## LearnHarness

GraphHarness is built to complement [LearnHarness](https://github.com/amosblomqvist/learnharness) by Amos Blomqvist (AGPL-3.0): a study interface grounded in learning science that sits next to it. The two programs talk over HTTP (`packages/lh-client`). **This repository contains no LearnHarness code and no LearnHarness data.** The client's types mirror LearnHarness's public HTTP API, and the test fixtures are synthetic (see `packages/lh-client/fixtures/README.md`).

## GraphLearn

Parts of the domain model, the evaluation service, the flashcard scheduler and the LaTeX pipeline were ported from GraphLearn, an earlier project. Every ported file carries a `Ported from graphlearn/...` header, and [docs/PROVENANCE.md](docs/PROVENANCE.md) maps each one to its origin and lists the adaptations.
