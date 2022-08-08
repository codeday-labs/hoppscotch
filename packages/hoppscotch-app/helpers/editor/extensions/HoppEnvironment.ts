import { watch, Ref } from "@nuxtjs/composition-api"
import { Compartment } from "@codemirror/state"
import { hoverTooltip } from "@codemirror/tooltip"
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
} from "@codemirror/view"
import * as E from "fp-ts/Either"
import { HoppRESTVar, parseTemplateStringE } from "@hoppscotch/data"
import { StreamSubscriberFunc } from "~/helpers/utils/composables"
import {
  AggregateEnvironment,
  aggregateEnvs$,
  getAggregateEnvs,
} from "~/newstore/environments"

const HOPP_ENVIRONMENT_REGEX = /(<<\w+>>)/g
const HOPP_VARIABLE_REGEX = /({{\w+}})/g

const HOPP_ENV_HIGHLIGHT =
  "cursor-help transition rounded px-1 focus:outline-none mx-0.5 env-highlight"
const HOPP_ENV_HIGHLIGHT_FOUND =
  "bg-accentDark text-accentContrast hover:bg-accent"
const HOPP_ENV_HIGHLIGHT_NOT_FOUND =
  "bg-red-500 text-accentContrast hover:bg-red-600"

const isOfTypeEnv = (input: any) => {
  let flag: boolean = false
  for (const variable of input) {
    if (variable.sourceEnv !== undefined) flag = true
  }
  return flag
}

const cursorTooltipField = (
  aggregateValues: AggregateEnvironment[] | HoppRESTVar[]
) =>
  hoverTooltip(
    (view, pos, side) => {
      const { from, to, text } = view.state.doc.lineAt(pos)

      // TODO: When Codemirror 6 allows this to work (not make the
      // popups appear half of the time) use this implementation
      // const wordSelection = view.state.wordAt(pos)
      // if (!wordSelection) return null
      // const word = view.state.doc.sliceString(
      //   wordSelection.from - 2,
      //   wordSelection.to + 2
      // )
      // if (!HOPP_ENVIRONMENT_REGEX.test(word)) return null

      // envType checks if the paraneter is dealing with an AggregateEnvironment[] or HoppRESTVar[] type
      const envType: boolean = isOfTypeEnv(aggregateValues)

      // Tracking the start and the end of the words
      let start = pos
      let end = pos

      while (start > from && /\w/.test(text[start - from - 1])) start--
      while (end < to && /\w/.test(text[end - from])) end++

      const HOPP_CURRENT_REGEX = envType
        ? HOPP_ENVIRONMENT_REGEX
        : HOPP_VARIABLE_REGEX

      if (
        (start === pos && side < 0) ||
        (end === pos && side > 0) ||
        !HOPP_CURRENT_REGEX.test(text.slice(start - from - 2, end - from + 2))
      )
        return null

      let envName: string = ""
      if (isOfTypeEnv(aggregateValues)) {
        envName =
          aggregateValues.find(
            (env) => env.key === text.slice(start - from, end - from)
            // env.key === word.slice(wordSelection.from + 2, wordSelection.to - 2)
          )?.sourceEnv ?? "choose an environment"
      }

      const value =
        aggregateValues.find(
          (x) => x.key === text.slice(start - from, end - from)
          // env.key === word.slice(wordSelection.from + 2, wordSelection.to - 2)
        )?.value ?? "not found"

      const result = parseTemplateStringE(value, aggregateValues)

      const finalValue = E.isLeft(result) ? "error" : result.right

      return {
        pos: start,
        end: to,
        above: true,
        arrow: true,
        create() {
          const dom = document.createElement("span")
          const xmp = document.createElement("xmp")
          xmp.textContent = finalValue
          if (envType) {
            dom.appendChild(document.createTextNode(`${envName} `))
          }
          dom.appendChild(xmp)
          dom.className = "tooltip-theme"
          return { dom }
        },
      }
    },
    // HACK: This is a hack to fix hover tooltip not coming half of the time
    // https://github.com/codemirror/tooltip/blob/765c463fc1d5afcc3ec93cee47d72606bed27e1d/src/tooltip.ts#L622
    // Still doesn't fix the not showing up some of the time issue, but this is atleast more consistent
    { hoverTime: 1 } as any
  )

function checkExistence(
  env: string,
  aggregateValues: AggregateEnvironment[] | HoppRESTVar[]
) {
  const className = aggregateValues.find(
    (k: { key: string }) => k.key === env.slice(2, -2)
  )
    ? HOPP_ENV_HIGHLIGHT_FOUND
    : HOPP_ENV_HIGHLIGHT_NOT_FOUND

  return Decoration.mark({
    class: `${HOPP_ENV_HIGHLIGHT} ${className}`,
  })
}

const getMatchDecorator = (
  aggregateValues: AggregateEnvironment[] | HoppRESTVar[]
) => {
  // envType checks if the parameter is dealing with an AggregateEnvironment[] or HoppRESTVar[] type
  const envType: boolean = isOfTypeEnv(aggregateValues)

  const HOPP_CURRENT_REGEX = envType
    ? HOPP_ENVIRONMENT_REGEX
    : HOPP_VARIABLE_REGEX
  return new MatchDecorator({
    regexp: HOPP_CURRENT_REGEX,
    decoration: (m) => checkExistence(m[0], aggregateValues),
  })
}

export const environmentHighlightStyle = (
  aggregateValues: AggregateEnvironment[] | HoppRESTVar[]
) => {
  const decorator = getMatchDecorator(aggregateValues)

  return ViewPlugin.define(
    (view) => ({
      decorations: decorator.createDeco(view),
      update(u) {
        this.decorations = decorator.updateDeco(u, this.decorations)
      },
    }),
    {
      decorations: (v) => v.decorations,
    }
  )
}

export class HoppEnvironmentPlugin {
  private compartment = new Compartment()

  private envs: AggregateEnvironment[] = []

  constructor(
    subscribeToStream: StreamSubscriberFunc,
    private editorView: Ref<EditorView | undefined>
  ) {
    this.envs = getAggregateEnvs()

    subscribeToStream(aggregateEnvs$, (envs) => {
      this.envs = envs

      this.editorView.value?.dispatch({
        effects: this.compartment.reconfigure([
          cursorTooltipField(this.envs),
          environmentHighlightStyle(this.envs),
        ]),
      })
    })
  }

  get extension() {
    return this.compartment.of([
      cursorTooltipField(this.envs),
      environmentHighlightStyle(this.envs),
    ])
  }
}

export class HoppReactiveEnvPlugin {
  private compartment = new Compartment()

  private envs: AggregateEnvironment[] = []

  constructor(
    envsRef: Ref<AggregateEnvironment[]>,
    private editorView: Ref<EditorView | undefined>
  ) {
    watch(
      envsRef,
      (envs) => {
        this.envs = envs

        this.editorView.value?.dispatch({
          effects: this.compartment.reconfigure([
            cursorTooltipField(this.envs),
            environmentHighlightStyle(this.envs),
          ]),
        })
      },
      { immediate: true }
    )
  }

  get extension() {
    return this.compartment.of([
      cursorTooltipField(this.envs),
      environmentHighlightStyle(this.envs),
    ])
  }
}

export class HoppReactiveVarPlugin {
  private compartment = new Compartment()

  private vars: HoppRESTVar[] = []

  constructor(
    varsRef: Ref<HoppRESTVar[]>,
    private editorView: Ref<EditorView | undefined>
  ) {
    watch(
      varsRef,
      (vars) => {
        this.vars = vars

        this.editorView.value?.dispatch({
          effects: this.compartment.reconfigure([
            cursorTooltipField(this.vars),
            environmentHighlightStyle(this.vars),
          ]),
        })
      },
      { immediate: true }
    )
  }

  get extension() {
    return this.compartment.of([
      cursorTooltipField(this.vars),
      environmentHighlightStyle(this.vars),
    ])
  }
}
