package dev.lilkuzco.hirelings.item;

import dev.lilkuzco.hirelings.Hirelings;
import java.util.List;
import net.fabricmc.fabric.api.creativetab.v1.CreativeModeTabEvents;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.component.ItemLore;

public final class HirelingsItems {
	public static final Item HELP_WANTED_NOTICE = register("help_wanted_notice",
			HelpWantedNoticeItem::new, new Item.Properties().stacksTo(16)
					.component(DataComponents.LORE, new ItemLore(List.of(
							Component.translatable("item.hirelings.help_wanted_notice.tooltip.1"),
							Component.translatable("item.hirelings.help_wanted_notice.tooltip.2")))));

	private static Item register(String name, java.util.function.Function<Item.Properties, Item> factory,
			Item.Properties properties) {
		ResourceKey<Item> key = ResourceKey.create(Registries.ITEM, Hirelings.id(name));
		return Registry.register(BuiltInRegistries.ITEM, key, factory.apply(properties.setId(key)));
	}

	public static void init() {
		CreativeModeTabEvents.modifyOutputEvent(CreativeModeTabs.INGREDIENTS).register(output ->
				output.insertAfter(Items.PAPER, HELP_WANTED_NOTICE));
	}

	private HirelingsItems() {
	}
}
