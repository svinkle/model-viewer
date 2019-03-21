/*
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {$controls, $promptElement, ControlsMixin, IDLE_PROMPT, IDLE_PROMPT_THRESHOLD_MS} from '../../features/controls.js';
import ModelViewerElementBase, {$scene} from '../../model-viewer-base.js';
import {assetPath, dispatchSyntheticEvent, rafPasses, timePasses, until, waitForEvent} from '../helpers.js';
import {BasicSpecTemplate} from '../templates.js';
import {settleControls} from '../three-components/SmoothControls-spec.js';

const expect = chai.expect;

const interactWith = (element) => {
  dispatchSyntheticEvent(element, 'mousedown', {clientX: 0, clientY: 10});
  dispatchSyntheticEvent(element, 'mousemove', {clientX: 0, clientY: 0});
};

suite('ModelViewerElementBase with ControlsMixin', () => {
  suite('when registered', () => {
    let nextId = 0;
    let tagName;
    let ModelViewerElement;

    setup(() => {
      tagName = `model-viewer-controls-${nextId++}`;
      ModelViewerElement = class extends ControlsMixin
      (ModelViewerElementBase) {
        static get is() {
          return tagName;
        }
      };
      customElements.define(tagName, ModelViewerElement);
    });

    BasicSpecTemplate(() => ModelViewerElement, () => tagName);

    suite('controls', () => {
      let element;

      setup(async () => {
        element = new ModelViewerElement();
        document.body.appendChild(element);
        element.src = assetPath('cube.gltf');
        element.controls = true;

        await waitForEvent(element, 'load');
      });

      teardown(() => {
        if (element.parentNode != null) {
          element.parentNode.removeChild(element);
        }
      });

      test('creates SmoothControls if enabled', () => {
        expect(element[$controls]).to.be.ok;
      });

      test('sets max radius to the camera framed distance', () => {
        const cameraZ = element[$scene].camera.position.z;
        expect(element[$controls].options.maximumRadius).to.be.equal(cameraZ);
      });

      test('removes SmoothControls if disabled after enabled', async () => {
        element.controls = false;
        await timePasses();
        expect(element[$controls]).to.be.not.ok;
      });

      suite('a11y', () => {
        setup(async () => {
          await rafPasses();
        });

        test('prompts user to interact when focused', async () => {
          const {canvas} = element[$scene];
          const promptElement = element[$promptElement];
          const originalLabel = canvas.getAttribute('aria-label');

          // NOTE(cdata): This wait time was added in order to deflake tests on
          // iOS Simulator and Android Emulator on Sauce Labs. These same test
          // targets were tested manually locally and manually on Sauce, and do
          // not fail. Only automated Sauce tests seem to fail consistently
          // without this additional wait time:
          await rafPasses();

          canvas.focus();

          await until(() => canvas.getAttribute('aria-label') === IDLE_PROMPT);

          expect(promptElement.classList.contains('visible')).to.be.equal(true);
        });

        test('does not prompt if user already interacted', async () => {
          const {canvas} = element[$scene];
          const promptElement = element[$promptElement];
          const originalLabel = canvas.getAttribute('aria-label');

          expect(originalLabel).to.not.be.equal(IDLE_PROMPT);

          canvas.focus();

          await timePasses();

          interactWith(canvas);

          await timePasses(IDLE_PROMPT_THRESHOLD_MS + 100);

          expect(canvas.getAttribute('aria-label'))
              .to.not.be.equal(IDLE_PROMPT);
          expect(promptElement.classList.contains('visible'))
              .to.be.equal(false);
        });

        test('announces camera orientation when orbiting horizontally', () => {
          const {canvas} = element[$scene];
          const controls = element[$controls];

          controls.setOrbit(-Math.PI / 2.0);
          settleControls(controls);

          expect(canvas.getAttribute('aria-label'))
              .to.be.equal('View from stage left');

          controls.setOrbit(Math.PI / 2.0);
          settleControls(controls);

          expect(canvas.getAttribute('aria-label'))
              .to.be.equal('View from stage right');

          controls.adjustOrbit(-Math.PI / 2.0, 0, 0);
          settleControls(controls);

          expect(canvas.getAttribute('aria-label'))
              .to.be.equal('View from stage back');

          controls.adjustOrbit(Math.PI, 0, 0);
          settleControls(controls);

          expect(canvas.getAttribute('aria-label'))
              .to.be.equal('View from stage front');
        });

        test('announces camera orientation when orbiting vertically', () => {
          const {canvas} = element[$scene];
          const controls = element[$controls];

          controls.setOrbit(0, 0);
          settleControls(controls);

          expect(canvas.getAttribute('aria-label'))
              .to.be.equal('View from stage upper-front');

          controls.adjustOrbit(0, -Math.PI / 2.0, 0);
          settleControls(controls);

          expect(canvas.getAttribute('aria-label'))
              .to.be.equal('View from stage front');

          controls.adjustOrbit(0, -Math.PI / 2.0, 0);
          settleControls(controls);

          expect(canvas.getAttribute('aria-label'))
              .to.be.equal('View from stage lower-front');
        });
      });
    });
  });
});
