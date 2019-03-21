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

import {Cache, CubeTexture, EventDispatcher, GammaEncoding, NearestFilter, RGBEEncoding, TextureLoader} from 'three';

import EquirectangularToCubeGenerator from '../third_party/three/EquirectangularToCubeGenerator.js';
import PMREMCubeUVPacker from '../third_party/three/PMREMCubeUVPacker.js';
import PMREMGenerator from '../third_party/three/PMREMGenerator.js';
import RGBELoader from '../third_party/three/RGBELoader.js';

import EnvironmentMapGenerator from './EnvironmentMapGenerator.js';

// Enable three's loader cache so we don't create redundant
// Image objects to decode images fetched over the network.
Cache.enabled = true;

const HDR_FILE_RE = /\.hdr$/;
const ldrLoader = new TextureLoader();
const hdrLoader = new RGBELoader();

const $cubeGenerator = Symbol('cubeGenerator');

const defaultConfig = {
  cubemapSize: 1024,
  synthesizedEnvmapSize: 256,
  pmremSamples: 32,
  pmremSize: 256,
  defaultEnvironmentPmremSamples: 8,
  defaultEnvironmentPmremSize: 256,
};

// Attach a `userData` object for arbitrary data on textures that
// originate from TextureUtils, similar to Object3D's userData,
// for help debugging, providing metadata for tests, and semantically
// describe the type of texture within the context of this application.
const userData = {
  url: null,
  // 'Equirectangular', 'Cube', 'PMREM'
  mapping: null,
};

export default class TextureUtils extends EventDispatcher {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {?number} config.cubemapSize
   * @param {?number} config.synthesizedEnvmapSize
   * @param {?number} config.pmremSamples
   * @param {?number} config.pmremSize
   */
  constructor(renderer, config = {}) {
    super();
    this.config = {...defaultConfig, ...config};
    this.renderer = renderer;
    this.environmentMapGenerator = new EnvironmentMapGenerator(this.renderer);
    this[$cubeGenerator] = null;
  }

  /**
   * @param {THREE.Texture} texture
   * @return {THREE.WebGLRenderCubeTarget}
   */
  equirectangularToCubemap(texture) {
    const generator = new EquirectangularToCubeGenerator(texture, {
      resolution: this.config.cubemapSize,
    });

    generator.update(this.renderer);

    generator.renderTarget.texture.userData = {
      ...userData,
      ...({
        url: texture.userData ? texture.userData.url : null,
        mapping: 'Cube',
      })
    };

    // It's up to the previously served texture to dispose itself,
    // and therefore the generator's render target.
    this[$cubeGenerator] = generator;

    return generator.renderTarget;
  }

  /**
   * @param {string} url
   * @return {Promise<THREE.Texture>}
   */
  async load(url) {
    const isHDR = HDR_FILE_RE.test(url);
    const loader = isHDR ? hdrLoader : ldrLoader;
    const texture = await new Promise(
        (resolve, reject) => loader.load(url, resolve, undefined, reject));
    texture.userData = {
      ...userData,
      ...({
        url: url,
        mapping: 'Equirectangular',
      })
    };

    if (isHDR) {
      texture.encoding = RGBEEncoding;
      texture.minFilter = NearestFilter;
      texture.magFilter = NearestFilter;
      texture.flipY = true;
    } else {
      texture.encoding = GammaEncoding;
    }

    return texture;
  }

  /**
   * @param {string} url
   * @return {Promise<THREE.WebGLRenderCubeTarget>}
   */
  async loadEquirectAsCubeMap(url) {
    let equirect = null;

    try {
      equirect = await this.load(url);
      return await this.equirectangularToCubemap(equirect);
    } finally {
      if (equirect != null) {
        equirect.dispose();
      }
    }
  }

  /**
   * Returns a { skybox, environmentMap } object with the targets/textures
   * accordingly. `skybox` is a WebGLRenderCubeTarget, and `environmentMap`
   * is a Texture from a WebGLRenderCubeTarget.
   *
   * @see equirectangularToCubemap with regard to the THREE types.
   * @param {string} url
   * @param {boolean} config.pmrem
   * @return {Promise<Object|null>}
   */
  async generateEnvironmentMapAndSkybox(
      skyboxUrl = null, environmentMapUrl = null, options = {}) {
    let skyboxLoads = Promise.resolve(null);
    let environmentMapLoads = Promise.resolve(null);

    let skybox = null;
    let environmentMap = null;

    try {
      let environmentMapWasGenerated = false;

      // If we have a skybox URL, attempt to load it as a cubemap
      if (!!skyboxUrl) {
        skyboxLoads = this.loadEquirectAsCubeMap(skyboxUrl);
      }

      // If we have a specific environment URL, attempt to load it as a cubemap
      // The case for this is that the user intends for the IBL to be different
      // from the scene background (which may be a skybox or solid color).
      if (!!environmentMapUrl) {
        environmentMapLoads = this.loadEquirectAsCubeMap(environmentMapUrl);
      }

      // In practice, this should be nearly as parallel as Promise.all (which
      // we don't use since we can't easily destructure here):
      skybox = await skyboxLoads;
      environmentMap = await environmentMapLoads;

      // If environment is still null, then no specific environment URL was
      // specified
      if (environmentMap != null) {
        environmentMap = environmentMap.texture
      } else {
        if (skybox != null) {
          // Infer the environment from the skybox if we have one:
          environmentMap = skybox.texture;
        } else {
          // Otherwise, no skybox URL was specified, so fall back to generating
          // the environment:
          // TODO(#336): can cache this per renderer and color
          environmentMap = this.environmentMapGenerator.generate(
              this.config.synthesizedEnvmapSize);
          environmentMapWasGenerated = true;
        }
      }

      if (options.pmrem) {
        // Apply the PMREM pass to the environment, which produces a distinct
        // texture from the source:
        const nonPmremEnvironmentMap = environmentMap;
        const samples = environmentMapWasGenerated ?
            this.config.defaultEnvironmentPmremSamples :
            this.config.pmremSamples;
        const size = environmentMapWasGenerated ?
            this.config.defaultEnvironmentPmremSize :
            this.config.pmremSize;

        environmentMap = this.pmremPass(nonPmremEnvironmentMap, samples, size);

        // If the source was generated, then we should dispose of it right away
        if (environmentMapWasGenerated) {
          nonPmremEnvironmentMap.dispose();
        }
      } else if (environmentMapWasGenerated) {
        environmentMap.userData = {
          ...userData,
          ...({
            mapping: 'Cube',
          })
        };
      }

      return {environmentMap, skybox};
    } catch (error) {
      if (skybox != null) {
        skybox.dispose();
      }

      if (environmentMap != null) {
        environmentMap.dispose();
      }

      throw error;
    }
  }

  /**
   * Takes a cube-ish (@see equirectangularToCubemap) texture and
   * returns a texture of the prefiltered mipmapped radiance environment map
   * to be used as environment maps in models.
   *
   * @param {THREE.Texture} texture
   * @param {number} samples
   * @param {number} resolution
   * @return {THREE.Texture}
   */
  pmremPass(texture, samples, size) {
    const generator = new PMREMGenerator(texture, samples, size);
    generator.update(this.renderer);

    const packer = new PMREMCubeUVPacker(generator.cubeLods);
    packer.update(this.renderer);

    const renderTarget = packer.CubeUVRenderTarget;

    generator.dispose();
    packer.dispose();

    renderTarget.texture.userData = {
      ...userData,
      ...({
        url: texture.userData ? texture.userData.url : null,
        mapping: 'PMREM',
      })
    };

    return renderTarget.texture;
  }

  dispose() {
    this.environmentMapGenerator.dispose();
    this.environmentMapGenerator = null;
    if (this[$cubeGenerator]) {
      this[$cubeGenerator].dispose();
      this[$cubeGenerator] = null;
    }
  }
}
