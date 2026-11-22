# Ported from graphlearn/apps/eval/app/main.py (65b56d6).
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, model_validator

import multiprocessing
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout

from app.formulas import expressions_equivalent, latex_expressions_equivalent
from app.evaluators.code_comprehension_v1 import validate as validate_code_comprehension
from app.recipes import validate as validate_recipe
from app.reproduce import reproduce as reproduce_error
from app.registry import EVALUATORS

app = FastAPI(title="GraphLearn eval")


class GenerateBody(BaseModel):
    evaluatorKey: str
    generationSpec: dict[str, Any] = Field(default_factory=dict)
    stepId: str


class GenerateResponse(BaseModel):
    stepId: str
    payload: dict[str, Any]


class PatternDetector(BaseModel):
    detectorKey: str
    patternHash: str


class GradeBody(BaseModel):
    evaluatorKey: str
    payload: dict[str, Any]
    stepId: str
    userInput: dict[str, Any]
    patternDetectors: list[PatternDetector] = Field(default_factory=list)


class GradeResponse(BaseModel):
    correct: bool
    detectorKey: str | None = None


class VerifyBody(BaseModel):
    left: str | None = Field(default=None, min_length=1)
    right: str | None = Field(default=None, min_length=1)
    latexLeft: str | None = Field(default=None, min_length=1, max_length=4000)
    latexRight: str | None = Field(default=None, min_length=1, max_length=4000)

    @model_validator(mode="after")
    def _one_mode(self) -> "VerifyBody":
        sym = self.left is not None or self.right is not None
        lat = self.latexLeft is not None or self.latexRight is not None
        if sym and lat:
            raise ValueError("mixed_modes")
        if not sym and not lat:
            raise ValueError("missing_pair")
        if sym and (self.left is None or self.right is None):
            raise ValueError("incomplete_sympy_pair")
        if lat and (self.latexLeft is None or self.latexRight is None):
            raise ValueError("incomplete_latex_pair")
        return self


class VerifyResponse(BaseModel):
    equivalent: bool


def _get_evaluator(key: str):
    ev = EVALUATORS.get(key)
    if ev is None:
        raise HTTPException(status_code=400, detail="unknown_evaluator")
    return ev


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/v1/generate", response_model=GenerateResponse)
def generate(body: GenerateBody) -> GenerateResponse:
    ev = _get_evaluator(body.evaluatorKey)
    payload = ev.generate(body.generationSpec)
    return GenerateResponse(stepId=body.stepId, payload=payload)


@app.post("/v1/grade", response_model=GradeResponse)
def grade(body: GradeBody) -> GradeResponse:
    from app.pattern_hash import user_input_pattern_hash

    ev = _get_evaluator(body.evaluatorKey)
    result = ev.grade(body.payload, body.userInput)
    if not result.get("correct") and not result.get("detectorKey") and body.patternDetectors:
        digest = user_input_pattern_hash(body.userInput)
        for pd in body.patternDetectors:
            if digest == pd.patternHash:
                return GradeResponse(correct=False, detectorKey=pd.detectorKey)
    return GradeResponse(**result)


@app.post("/v1/formulas/verify", response_model=VerifyResponse)
def verify_formulas(body: VerifyBody) -> VerifyResponse:
    try:
        if body.latexLeft is not None:
            equivalent = latex_expressions_equivalent(body.latexLeft, body.latexRight)
        else:
            equivalent = expressions_equivalent(body.left, body.right)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid_expression")
    return VerifyResponse(equivalent=equivalent)


class RecipeValidateBody(BaseModel):
    recipe: dict[str, Any]
    seed: int = 0


class CodeComprehensionValidateBody(BaseModel):
    recipe: dict[str, Any]
    seed: int = 0


RECIPE_VALIDATE_TIMEOUT_S = 30
# Separate process: a recipe that hangs SymPy does not block the service (039.4).
_recipe_pool: ProcessPoolExecutor | None = None


def _pool() -> ProcessPoolExecutor:
    global _recipe_pool
    if _recipe_pool is None:
        _recipe_pool = ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context("spawn"))
    return _recipe_pool


@app.post("/v1/code-comprehension/validate")
def code_comprehension_validate(body: CodeComprehensionValidateBody) -> dict[str, Any]:
    """Checks a code-comprehension recipe (ADR 108)."""
    return validate_code_comprehension(body.recipe, body.seed)


@app.post("/v1/recipes/validate")
def recipes_validate(body: RecipeValidateBody) -> dict[str, Any]:
    """Automatic check of a recipe written by the AI (039.4, points 1–6)."""
    global _recipe_pool
    future = _pool().submit(validate_recipe, body.recipe, body.seed)
    try:
        return future.result(timeout=RECIPE_VALIDATE_TIMEOUT_S)
    except FutureTimeout:
        # The hung process is discarded entirely.
        _recipe_pool.shutdown(wait=False, cancel_futures=True)  # type: ignore[union-attr]
        for p in list(getattr(_recipe_pool, "_processes", {}).values()):
            p.kill()
        _recipe_pool = None
        return {
            "ok": False,
            "problems": [f"validation took longer than {RECIPE_VALIDATE_TIMEOUT_S} s"],
            "droppedErrors": [],
            "stats": {},
            "samples": [],
            "recipe": None,
        }


class ErrorCandidate(BaseModel):
    key: str
    description: str
    expr: str


class ReproduceBody(BaseModel):
    recipe: dict[str, Any]
    instancePayload: dict[str, Any]
    userInput: dict[str, Any]
    candidate: ErrorCandidate
    samples: int = Field(default=5, ge=5, le=50)


@app.post("/v1/errors/reproduce")
def errors_reproduce(body: ReproduceBody) -> dict[str, Any]:
    """Does the candidate reproduce the student's answer and stand out from the others?"""
    return reproduce_error(body.recipe, body.instancePayload, body.userInput, body.candidate.model_dump(), body.samples)
