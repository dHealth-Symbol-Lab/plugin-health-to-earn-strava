/**
 * This file is part of dHealth Wallet Plugins shared under LGPL-3.0
 * Copyright (C) 2021 Using Blockchain Ltd, Reg No.: 12658136, United Kingdom
 *
 * @package     dHealth Wallet Plugins
 * @subpackage  Health to Earn powered by Strava
 * @author      Grégory Saive for Using Blockchain Ltd <greg@ubc.digital>
 * @license     LGPL-3.0
 */
import Vue from 'vue';
import { Address, RepositoryFactoryConfig, RepositoryFactoryHttp } from '@dhealth/sdk';
import { PluginBridge } from '@dhealth/wallet-api-bridge';

/**
* @class {WalletService}
* @description This service class provides methods to handle
*              communication with the Wallet IPC.
*/
export class WalletService {
  /// region public API
  /**
   * Constructs a wallet service around an optional \a $app
   * Vue component/parent component.
   *
   * @param {Vue} $app
   */
  public constructor(protected readonly $app?: Vue) {}

  /**
   * This method reads the repository factory from the Vuex app store
   * to be able to use the network connection.
   *
   * @async
   * @returns {Promise<RepositoryFactoryHttp>}
   */
  public async getRepositoryFactory(): Promise<RepositoryFactoryHttp> {
    // Uses IPC to get repository factory from app store (Vuex)
    const networkBus = await PluginBridge.StoreActionRequest(
      '@dhealthdapps/health-to-earn',
      PluginBridge.PluginPermissionType.Getter,
      'network/repositoryFactory',
    );

    const info: any = networkBus.response;
    console.log("repository factory from IPC: ", info);

    try {
      return await new RepositoryFactoryHttp(info.url, {
        websocketInjected: WebSocket,
        websocketUrl: info.websocketUrl,
      } as RepositoryFactoryConfig);
    }
    catch(e) {
      throw new Error(`Connection to endpoint "${info.url}" could not be established. Reason: ${e.toString()}`);
    }
  }

  /**
   * Requests the current signer from the Wallet IPC.
   *
   * @returns {Promise<Address>}
   */
  public async getCurrentSigner(): Promise<Address> {
    // Uses IPC to get repository factory from app store (Vuex)
    const networkBus = await PluginBridge.StoreActionRequest(
      '@dhealthdapps/health-to-earn',
      PluginBridge.PluginPermissionType.Getter,
      'account/currentSignerAddress',
    );

    const info: any = networkBus.response;
    console.log("current signer from IPC: ", info);

    return Address.createFromRawAddress(info.address);
  }
  /// end-region public API
}
