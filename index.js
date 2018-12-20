const	ACTION_DELAY_THROW_ROD	= [6023, 6798],		// [Min, Max] in ms, 1000 ms = 1 sec
		ACTION_DELAY_FISH_START	= [1345, 2656],		// [Min, Max] - the pressing of F button to reel and start the minigame
		ACTION_DELAY_FISH_CATCH	= [5564, 15453],	// [Min, Max] - time to win the fishing minigame and get a fish as prize
		DELAY_BASED_ON_FISH_TIER= true; // tier 4 would get caught 4 sec longer, BAF (tier 11) would get caught 11 sec longer etc

const   path = require('path'),
		fs = require('fs');
				
const BAIT_RECIPES = [
	{name: "Bait II",	itemId: 206001, recipeId: 204100},
	{name: "Bait III",	itemId: 206002, recipeId: 204101},
	{name: "Bait IV",	itemId: 206003, recipeId: 204102},
	{name: "Bait V",	itemId: 206004, recipeId: 204103}
];
		
module.exports = function LetMeFish(mod) {
	const command = mod.command;
	
	let enabled = false,
		scanning = false,
		too_much_fishes = false,
		triedDismantling = false,
		myGameId = 0n,
		statFished = 0,
		statFishedTiers = {},
		hooks = [],
		toDismantle = {},
		thefishes = [],
		curTier = 0,
		timer = null,
		rodId = 0,
		baitId = 0,
		craftId = 0,
		leftArea = 0,
		playerLoc = null,
		vContractId = null,
		invenItems = [],
		statStarted = null,
		gSettings = {},
		settingsFileName,
		hasNego = mod.manager.isLoaded('auto-nego'),
		pendingDeals = [],
		negoWaiting = false;
	
	function saveSettings(obj)
	{
		if (Object.keys(obj).length)
		{
			try
			{
				fs.writeFileSync(path.join(__dirname, settingsFileName), JSON.stringify(obj, null, "\t"));
			}
			catch (err)
			{
				command.message("Erreur d'enregistrement des paramètres" + err);
				return false;
			}
		}
	}

	function loadSettings()
	{
		try
		{
			return JSON.parse(fs.readFileSync(path.join(__dirname, settingsFileName), "utf8"));
		}
		catch (err)
		{
			//console.log("Error loading settings " + err);
			return {};
		}
	}
	
	if(!fs.existsSync(path.join(__dirname, './saves')))
	{
		fs.mkdirSync(path.join(__dirname, './saves'));
	}

	command.add('fish', {
        $default() {
            enabled = !enabled;
			command.message(`Let me Fish is now: ${enabled ? "enabled" : "disabled"}.`);
			if(enabled)
			{
				start();
				scanning = true;
				if(!craftId)
				{
					command.message("1) Cliquez sur craft sur une recette d'appât que vous souhaitez créer automatiquement");
				}
				if(!Object.keys(toDismantle).length)
				{
					command.message("2) Mettez tous les types de poissons que vous souhaitez démanteler automatiquement dans la fenêtre de démantèlement");
				}
				command.message("3) Lancez votre canne - et elle démarrera automatiquement");
			}
			else
			{
				Stop();
			}
        },
		reset() {
			toDismantle = {};
			craftId = 0;
			baitId = 0;
			command.message("Recette auto-craft réinitialisée");
			command.message("Type d'appât pour réutilisation réinitialisée");
			command.message("Liste des poissons à auto-démanteler réinitialisée");
		},
		list() {
			command.message("Recette pour auto-craft: " + (craftId ? craftId : "none"));
			command.message("Appât pour la réutilisation après craft: " + (baitId ? baitId : "none"));
			command.message("Le poisson-liste pour l'auto-démantèlent (" + (Object.keys(toDismantle).length) + "):");
			if(Object.keys(toDismantle).length)
			{
				for(let i in toDismantle)
				{
					command.message(i);
				}
			}
			else
			{
				command.message("none");
			}
		},
		save() {
			command.message("Les paramètres enregistrés et seront reportés à la prochaine session sur ce personnager");
			gSettings.toDismantle = toDismantle;
			gSettings.craftId = craftId;
			gSettings.baitId = baitId;
			saveSettings(gSettings);
		},
		load() {
			command.message("fichier de paramètres rechargé");
			gSettings = loadSettings();
		}
	});
	
	function addZero(i) 
	{
		if (i < 10) {
			i = "0" + i;
		}
		return i;
	}
	
	function rng([min, max])
	{
		return min + Math.floor(Math.random() * (max - min + 1));
	}
	
	function Stop()
	{
		enabled = false
		vContractId = null;
		unload();
		clearTimeout(timer);
		if(!scanning)
		{
			let d = new Date();
			let t = d.getTime();
			let timeElapsedMSec = t-statStarted;
			d = new Date(1970, 0, 1); // Epoch
			d.setMilliseconds(timeElapsedMSec);
			let h = addZero(d.getHours());
			let m = addZero(d.getMinutes());
			let s = addZero(d.getSeconds());
			command.message('Fished out: ' + statFished + ' fishes. Time elapsed: ' + (h + ":" + m + ":" + s) + ". Per fish: " + Math.round((timeElapsedMSec / statFished) / 1000) + " sec");
			command.message('Fishes: ');
			for(let i in statFishedTiers)
			{
				command.message('Tier ' + i + ': ' + statFishedTiers[i]);
			}
			statFished = 0;
			statFishedTiers = {};
		}
		else
		{
			command.message('Vous avez décidé de ne pas pêcher?');
		}
	}
	
	function reel_the_fish()
	{
		mod.toServer("C_START_FISHING_MINIGAME", 1, {});
	}
	
	function catch_the_fish()
	{
		statFished++;
		mod.toServer("C_END_FISHING_MINIGAME", 1, {success:true});
		timer = setTimeout(throw_the_rod, rng(ACTION_DELAY_THROW_ROD));
	}
	
	function throw_the_rod()
	{
		if(pendingDeals.length)
		{
			command.message("Permet de traiter les offres suggérées et de lui donner du temps ...");
			//console.log("nego start wait");
			
			for(let i = 0; i < pendingDeals.length; i++)
			{
				mod.toClient('S_TRADE_BROKER_DEAL_SUGGESTED', 1, pendingDeals[i]);
				pendingDeals.splice(i--, 1);
			}
			negoWaiting = true;
			timer = setTimeout(throw_the_rod, (rng(ACTION_DELAY_THROW_ROD)*6));
		}
		else if(rodId)
		{
			negoWaiting = false;
			mod.toServer('C_USE_ITEM', 3, {
				gameId: myGameId,
				id: rodId,
				dbid: 0n, // dbid is sent only when used from inventory, but not from quickslot
				target: 0n,
				amount: 1,
				dest: 0,
				loc: playerLoc.loc,
				w: playerLoc.w,
				unk1: 0,
				unk2: 0,
				unk3: 0,
				unk4: true
			});
		}
		else
		{
			command.message("Vous n'avez pas utilisé votre canne à pêche quand on vous l'a dit, n'est-ce pas? Maintenant, l'auto-pêche ne peut plus la repasser pour vous ...");
			Stop();
		}
	}
	
	function use_bait_item()
	{
		if(baitId)
		{
			mod.toServer('C_USE_ITEM', 3, {
				gameId: myGameId,
				id: baitId,
				dbid: 0n, // dbid is sent only when used from inventory, but not from quickslot
				target: 0n,
				amount: 1,
				dest: 0,
				loc: playerLoc.loc,
				w: playerLoc.w,
				unk1: 0,
				unk2: 0,
				unk3: 0,
				unk4: true
			});
			timer = setTimeout(throw_the_rod, rng(ACTION_DELAY_THROW_ROD));
		}
		else
		{
			command.message("Comment pouvez-vous pêcher sans appât? ... hmmm...");
			Stop();
		}
	}
	
	function cleanup_by_dismantle()
	{
		if(enabled)
		{
			if(Object.keys(toDismantle).length)
			{
				thefishes.length = 0;
				for(let i in toDismantle)
				{
					 thefishes = thefishes.concat(invenItems.filter((item) => item.id === parseInt(i,10)));
				}
				if(thefishes.length > 20)
				{
					too_much_fishes = true;
					while(thefishes.length > 20)
					{
						thefishes.pop();
					}
				}
				else
				{
					too_much_fishes = false;
				}
				if(thefishes.length)
				{
					command.message("Va démanteler autant de poissons: " + thefishes.length);
					if(!vContractId)
					{
						mod.toServer('C_REQUEST_CONTRACT', 1, {type: 89});
					}
					timer = setTimeout(dismantle_put_in_one_fish, (rng(ACTION_DELAY_FISH_START)+1000));
				}
				else
				{
					command.message("Aucun poisson à démanteler ne se trouve dans votre inventaire, impossible de libérer de l'espace, arrêt");
					console.log("Aucun poisson à démanteler ne se trouve dans votre inventaire, impossible de libérer de l'espace, arrêt");
					Stop();
				}
			}
			else
			{
				command.message("Vous n'avez pas fourni de liste de poissons à démanteler automatiquement, n'est-ce pas? Maintenant, l'auto-pêche ne peut plus vous libérer d'espace d'inventaire ...");
				Stop();
			}
		}
	}
	
	function dismantle_put_in_one_fish()
	{
		if(vContractId)
		{
			const thefish = thefishes.pop();
			
			mod.toServer('C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT', 1, {
				contractId: vContractId,
				dbid: thefish.dbid,
				id: thefish.id,
				count: 1
			});

			if(thefishes.length)
			{
				timer = setTimeout(dismantle_put_in_one_fish, (rng(ACTION_DELAY_FISH_START)/4));
			}
			else
			{
				timer = setTimeout(dismantle_start0, (rng(ACTION_DELAY_FISH_START)/2));
			}
		}
		else
		{
			command.message("Hmmm... nous n'avons pas reçu de demande de démantèlement pour une raison quelconque (lag?) ... essayons encore");
			timer = setTimeout(cleanup_by_dismantle, (rng(ACTION_DELAY_FISH_START)+1500));
		}
	}
	
	function dismantle_start0()
	{
		mod.toServer('C_RQ_START_SOCIAL_ON_PROGRESS_DECOMPOSITION', 1, { contract: vContractId });
		timer = setTimeout(dismantle_start, 1925);
	}
	
	function dismantle_start()
	{
		mod.toServer('C_RQ_COMMIT_DECOMPOSITION_CONTRACT', 1, {contract: vContractId});
		if(too_much_fishes)
		{
			cleanup_by_dismantle();
		}
		else
		{
			setTimeout(dismantle_start2, rng(ACTION_DELAY_FISH_START)); // lets not let user cancel that
		}
	}
	
	function dismantle_start2()
	{
		mod.toServer('C_CANCEL_CONTRACT', 1, {
			type: 89,
			id: vContractId
		});
		vContractId = null;
		if(enabled)
		{
			timer = setTimeout(throw_the_rod, rng(ACTION_DELAY_THROW_ROD)); // lets resume fishing
		}
	}
	
	function craft_bait_start()
	{
		if(craftId)
		{
			let filets = invenItems.find((item) => item.id === 204052);
			if(filets && filets.amount >= 30)
			{
				triedDismantling = false;
				mod.toServer('C_START_PRODUCE', 1, {recipe:craftId, unk: 0});
			}
			else if(!triedDismantling)
			{
				triedDismantling = true;
				timer = setTimeout(cleanup_by_dismantle, rng(ACTION_DELAY_THROW_ROD));
				command.message("Vous n'avez pas assez de poisson pour fabriquer un appât ... démanteler des poissons pour en obtenir");
			}
			else
			{
				command.message("Vous n'avez pas assez de morceaux de poisson pour fabriquer un appât et pas de poisson à démonter pour les morceaux de poisson ... arrêt");
				console.log("Vous n'avez pas assez de morceaux de poisson pour fabriquer un appât et pas de poisson à démonter pour les morceaux de poisson ... arrêt");
				Stop();
			}
		}
		else
		{
			command.message("Vous n'avez pas fourni d'exemple de recette d'artisanat, n'est-ce pas? Maintenant, Auto-fish ne peut plus fabriquer d'appâts pour vous ...");
			Stop();
		}
	}

	mod.hook('C_PLAYER_LOCATION', 5, event => {
		playerLoc = event;
	});

	mod.hook('S_LOGIN', 12, event => {
		myGameId = event.gameId;
		invenItems = [];
		rodId = null;
		vContractId = null;
		settingsFileName = `./saves/${event.name}-${event.serverId}.json`;
		gSettings = loadSettings();
		if(!Object.keys(gSettings).length)
		{
			baitId = 0;
			craftId = 0;
			toDismantle = {}
		}
		else
		{
			toDismantle = gSettings.toDismantle;
			craftId = gSettings.craftId;
			baitId = gSettings.baitId;
			/*console.log("LOADED SETTINGS: ");
			console.log(toDismantle);
			console.log(craftId);
			console.log(baitId);*/
		}
	});
		
	function start()
	{
		if(hooks.length) return;
		
		Hook('S_START_FISHING_MINIGAME', 1, event => {
			if (!enabled || scanning) return;
			
			//let eventgameId = BigInt(data.readUInt32LE(8)) | BigInt(data.readUInt32LE(12)) << 32n;
			if(myGameId === event.gameId)
			{
				let fishTier = event.level; //data.readUInt8(16);
				if(DELAY_BASED_ON_FISH_TIER)
				{
					curTier = fishTier;
				}
				statFishedTiers[fishTier] = statFishedTiers[fishTier] ? statFishedTiers[fishTier]+1 : 1;
				//console.log("size of statFishedTiers now: " + (Object.keys(statFishedTiers).length));
				//console.log(statFishedTiers);
				command.message("Started fishing minigame, Tier: " + fishTier);
				timer = setTimeout(catch_the_fish, (rng(ACTION_DELAY_FISH_CATCH)+(curTier*1000)));
				return false; // lets hide that minigame
			}
		});
		
		Hook('S_FISHING_BITE', 1, event => {
			if (!enabled) return;
			
			//let eventgameId = BigInt(data.readUInt32LE(8)) | BigInt(data.readUInt32LE(12)) << 32n;
			if(myGameId === event.gameId)
			{
				timer = setTimeout(reel_the_fish, rng(ACTION_DELAY_FISH_START));
				leftArea = 0;
				if(scanning)
				{
					scanning = false;
					rodId = event.rodId;
					let d = new Date();
					statStarted = d.getTime();
					command.message("Rod set to: " + rodId);
					if(!craftId)
					{
						command.message("Vous n'avez pas fourni de recette d'appât pour la fabrication artisanale, l'auto-pêche s'arrêtera dès qu'elle sera à court d'appâts ...");
					}
					if(!Object.keys(toDismantle).length)
					{
						command.message("Vous n'avez pas fourni de liste de poissons à démanteler automatiquement, ce dernier s'arrêtera dès que l'inventaire sera à court d'espace ...");
					}
					command.message("La pêche automatique est commencée maintenant");
				}
				command.message("Le poisson a votre appât ");
				return false; // lets hide and enjoy peace of mind with no temptation to smash "F" button
			}
		});
		
		Hook('S_INVEN', 16, event => {
			if(!enabled) return;
			
			invenItems = event.first ? event.items : invenItems.concat(event.items);
		});
		
		Hook('C_RQ_ADD_ITEM_TO_DECOMPOSITION_CONTRACT', 1, event =>{
			if(!scanning) return;
			
			toDismantle[event.id] = true;
			command.message("Maintenant, les poissons avec cet identifiant seraient automatiquement démantelés: " + event.id);
			//console.log("size of toDismantle now: " + (Object.keys(toDismantle).length));
			//console.log(toDismantle);
		});
		
		Hook('S_REQUEST_CONTRACT', 1, event =>{
			if(!enabled || scanning || event.type != 89 || event.senderId !== myGameId) return;
			
			vContractId = event.id;
			command.message("Got the contract id for dismantling: " + event.id);
		});
		
		Hook('S_CANCEL_CONTRACT', 1, event =>{
			if(!enabled || scanning || event.type != 89 || event.id != vContractId || event.senderId !== myGameId) return;
			
			vContractId = null;
			command.message("demande de démantèlement annulée (pas par auto-poisson), nouvelle tentative de démantèlement ...");
			clearTimeout(timer);
			timer = setTimeout(cleanup_by_dismantle, rng(ACTION_DELAY_THROW_ROD));
		});

		Hook('C_START_PRODUCE', 1, event =>{
			if(!scanning) return;
			
			craftId = event.recipe;
			let found = BAIT_RECIPES.find(obj => obj.recipeId === event.recipe);
			if(found)
			{
				baitId = found.itemId;
				command.message("Maintenant, cette recette serait utiliser quand vous n'aurais plus d'appâts: " + event.recipe + ", et cet appât serait activé après: " + baitId);
			}
			else
			{
				command.message("Qu'est-ce que tu viens de fabriquer à la place d'un appât?! Allez fabriquer des appâts!");
			}
		});
		
		Hook('S_END_PRODUCE', 1, event =>{
			if(!enabled || scanning) return;
			
			if(event.success)
			{
				craft_bait_start(); // no need to wait, client doesn't (when you click "craft all")
			}
		});
		
		Hook('S_TRADE_BROKER_DEAL_SUGGESTED', 1, event => {
			if(hasNego && !negoWaiting && event.offeredPrice === event.sellerPrice) // lets take a break and trade shall we?
			{
				for(let i = 0; i < pendingDeals.length; i++)
				{
					let deal = pendingDeals[i];
					if(deal.playerId == event.playerId && deal.listing == event.listing) pendingDeals.splice(i--, 1);
				}
				pendingDeals.push(event);
				//console.log("nego deal suggested");
				command.message("Un accord de négociation a été suggéré, je vais y répondre après le poisson actuel ...")
				return false;
			}
		});
		
		Hook('S_SYSTEM_MESSAGE', 1, event => {
			if(!enabled || scanning) return;
			const msg = mod.parseSystemMessage(event.message);
			//command.message(msg.id);
			
			if(msg.id === 'SMT_CANNOT_FISHING_NON_BAIT') // out of bait
			{
				command.message("Out of bait, lets craft some!");
				clearTimeout(timer);
				timer = setTimeout(craft_bait_start, rng(ACTION_DELAY_FISH_START));
			}
			else if(msg.id === 'SMT_ITEM_CANT_POSSESS_MORE') // craft limit
			{
				if(!vContractId)
				{
					command.message("Fabriqué au maximum, permet de pêcher à nouveau!");
					clearTimeout(timer);
					timer = setTimeout(use_bait_item, rng(ACTION_DELAY_FISH_START));
				}
				else // 10k filet // 3 error sysmsgs at once for that lol
				{
					command.message("Vous avez atteint la limite des 10 000 pièces de poisson démontées, arrêt");
					console.log("Vous avez atteint la limite des 10 000 pièces de poisson démontées, arrêt");
					Stop();
				}
			}
			else if(msg.id === 'SMT_CANNOT_FISHING_FULL_INVEN') // full inven
			{
				command.message("Inventaire complet, permet de démanteler les poissons!");
				clearTimeout(timer);
				timer = setTimeout(cleanup_by_dismantle, rng(ACTION_DELAY_FISH_START));
			}
			else if(msg.id === 'SMT_CANNOT_FISHING_NON_AREA' && !negoWaiting) // server trolling us?
			{
				command.message("Zone de pêche a changé (vous l'avez laissée?), bien que cela arrive ... nous allons essayer à nouveau?");
				console.log("Zone de pêche a changé (vous l'avez laissée?), bien que cela arrive ... nous allons essayer à nouveau?");
				clearTimeout(timer);
				leftArea++;
				if(leftArea < 6)
				{
					timer = setTimeout(throw_the_rod, rng(ACTION_DELAY_THROW_ROD));
				}
				else
				{
					Stop();
					command.message("Zone de pêche a changé pour de bon il semble, ne peut plus pêcher, arrêter");
					console.log("Zone de pêche a changé pour de bon il semble, ne peut plus pêcher, arrêter");
				}
			}
			else if(msg.id === 'SMT_FISHING_RESULT_CANCLE') // hmmm?
			{
				command.message("Pêche annulée ... Essayons encore?");
				console.log("Pêche annulée ... en raison d'un lag? Réessayer ...");
				clearTimeout(timer);
				timer = setTimeout(throw_the_rod, rng(ACTION_DELAY_THROW_ROD));
			}
			else if(negoWaiting && !pendingDeals.length && msg.id === 'SMT_MEDIATE_SUCCESS_SELL') // all out of deals and still waiting?
			{
				command.message('Toutes les négociations sont terminées ... reprise de la pêche sous peu')
				//console.log("nego end wait OK");
				clearTimeout(timer);
				timer = setTimeout(throw_the_rod, (rng(ACTION_DELAY_THROW_ROD)+1000));
			}
			else if(msg.id === 'SMT_CANNOT_USE_ITEM_WHILE_CONTRACT') // we want to throw the rod but still trading?
			{
				negoWaiting = true;
				command.message('Les négociations mettent du temps à se terminer ... attendons encore un peu')
				//console.log("nego long wait");
				clearTimeout(timer);
				timer = setTimeout(throw_the_rod, (rng(ACTION_DELAY_THROW_ROD)+3000));
			}
        });
	}
	
	function unload()
	{
		if(hooks.length)
		{
			for(let h of hooks) mod.unhook(h);
			hooks = [];
		}
	}

	function Hook()
	{
		hooks.push(mod.hook(...arguments));
	}
}